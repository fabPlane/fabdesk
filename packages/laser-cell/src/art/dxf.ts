/**
 * ASCII DXF → ArtGeometry. Reads the group-code pairs, the drawing units ($INSUNITS), layers (entities on
 * hidden or frozen layers are skipped), blocks placed with INSERT, and the 2D entities that make outlines.
 *
 * Open pieces (lines, arcs, open polylines and splines) whose ends meet are chained; chains that close become
 * fills, the rest are lines. Closed entities (circles, closed polylines, whole ellipses) are fills. All fills
 * are resolved together with the even-odd rule, so an outline inside another is a hole, as laser programs
 * read DXF.
 */
import type { ArtGeometry, Vec } from "./index";
import {
  ArtImportError,
  PointBudget,
  apply,
  arcSteps,
  chordsFor,
  count,
  finish,
  flattenCubic,
  maxScale,
  mul,
  rotate,
  scale,
  toleranceOf,
  translate,
  type Mat,
} from "./geometry";

/** Pieces whose ends are closer than this (in mm) are joined. */
const CHAIN_TOLERANCE_MM = 1e-3;
const MAX_INSERT_DEPTH = 32;

/** $INSUNITS codes → mm. 0 (unitless) is read as mm. */
const UNITS_MM: Record<number, number> = {
  0: 1, 1: 25.4, 2: 304.8, 3: 1_609_344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 25.4e-6, 9: 0.0254, 10: 914.4,
  11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 1e4, 16: 1e5,
};

/** Mirrors x: the object coordinate system of an entity whose extrusion direction is (0, 0, −1). */
const MIRROR_X: Mat = [-1, 0, 0, 1, 0, 0];

// ---------------------------------------------------------------- group codes

type Group = { code: number; value: string; line: number };

function readGroups(text: string): Group[] {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
  if (lines.length % 2) throw new ArtImportError(`not a valid DXF file: it ends in the middle of a group (line ${lines.length})`);
  const groups: Group[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = lines[i]!.trim();
    if (!/^[+-]?\d+$/.test(code)) {
      throw new ArtImportError(`not a valid DXF file: line ${i + 1} should be a group code (a whole number) but reads "${code.slice(0, 40)}"`);
    }
    groups.push({ code: Number(code), value: lines[i + 1]!.trim(), line: i + 2 });
  }
  return groups;
}

function toNumber(g: Group): number {
  const v = Number(g.value);
  if (g.value === "" || !Number.isFinite(v)) {
    throw new ArtImportError(`not a valid DXF file: line ${g.line} should be a number (group code ${g.code}) but reads "${g.value.slice(0, 40)}"`);
  }
  return v;
}

/** One record (entity, table entry, block header…): its type and its groups up to the next code 0. */
class Rec {
  constructor(readonly type: string, readonly groups: Group[]) {}

  str(code: number): string | undefined {
    return this.groups.find(g => g.code === code)?.value;
  }

  num(code: number, fallback = 0): number {
    const g = this.groups.find(g => g.code === code);
    return g ? toNumber(g) : fallback;
  }

  /** All values of a numeric code, in order (spline knots, weights). */
  nums(code: number): number[] {
    return this.groups.filter(g => g.code === code).map(toNumber);
  }

  /** Points from an x/y code pair (10/20, 11/21…): each x starts a point. */
  points(xCode: number): Vec[] {
    const out: Vec[] = [];
    for (const g of this.groups) {
      if (g.code === xCode) out.push([toNumber(g), 0]);
      else if (g.code === xCode + 10 && out.length) out.at(-1)![1] = toNumber(g);
    }
    return out;
  }
}

function records(groups: Group[]): Rec[] {
  const out: Rec[] = [];
  for (const g of groups) {
    if (g.code === 0) out.push(new Rec(g.value, []));
    else out.at(-1)?.groups.push(g);
  }
  return out;
}

// ---------------------------------------------------------------- curves

type PolyVertex = { p: Vec; bulge: number };

/** Points of an arc around `c` (local units), from angle a0 sweeping `sweep` radians (positive = CCW), in final mm. */
function arcPoints(m: Mat, c: Vec, r: number, a0: number, sweep: number, tol: number, budget: PointBudget, withStart: boolean): Vec[] {
  const n = arcSteps(maxScale(m) * r, sweep, tol);
  budget.take(n + 1);
  const out: Vec[] = [];
  for (let i = withStart ? 0 : 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(apply(m, [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]));
  }
  return out;
}

/**
 * A polyline with bulges, in final mm. A bulge is tan(θ/4) of the arc from this vertex to the next
 * (θ its included angle, positive = counter-clockwise).
 */
function polylinePoints(verts: PolyVertex[], closed: boolean, m: Mat, tol: number, budget: PointBudget): Vec[] {
  if (!verts.length) return [];
  const out: Vec[] = [apply(m, verts[0]!.p)];
  const segments = closed ? verts.length : verts.length - 1;
  budget.take(segments);
  for (let i = 0; i < segments; i++) {
    const { p: a, bulge } = verts[i]!, b = verts[(i + 1) % verts.length]!.p;
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (Math.abs(bulge) < 1e-9 || chord === 0) {
      out.push(apply(m, b));
      continue;
    }
    const theta = 4 * Math.atan(bulge);
    const r = chord / 2 / Math.abs(Math.sin(theta / 2));
    // The centre sits on the chord's perpendicular bisector, left of a→b for a counter-clockwise arc.
    const h = chord / 2 / Math.tan(theta / 2);
    const c: Vec = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / chord) * h, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / chord) * h];
    const pts = arcPoints(m, c, r, Math.atan2(a[1] - c[1], a[0] - c[0]), theta, tol, budget, false);
    pts[pts.length - 1] = apply(m, b); // land exactly on the next vertex
    out.push(...pts);
  }
  if (closed) out.pop(); // the last segment ends on the first vertex
  return out;
}

/** The span k with knots[k] ≤ u < knots[k + 1] (the last non-empty span for the end of the domain). */
function findSpan(knots: number[], p: number, n: number, u: number): number {
  if (u >= knots[n + 1]!) {
    let k = n;
    while (k > p && knots[k]! >= knots[n + 1]!) k--;
    return k;
  }
  let k = p;
  while (k < n && u >= knots[k + 1]!) k++;
  return k;
}

/** de Boor's algorithm, in homogeneous coordinates when there are weights. */
function deBoor(p: number, knots: number[], ctrl: Vec[], weights: number[] | null, u: number, k: number): Vec {
  const d: Array<[number, number, number]> = [];
  for (let j = 0; j <= p; j++) {
    const i = j + k - p;
    const w = weights ? weights[i]! : 1;
    d.push([ctrl[i]![0] * w, ctrl[i]![1] * w, w]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = knots[i + p - r + 1]! - knots[i]!;
      const a = den === 0 ? 0 : (u - knots[i]!) / den;
      const lo = d[j - 1]!, hi = d[j]!;
      d[j] = [(1 - a) * lo[0] + a * hi[0], (1 - a) * lo[1] + a * hi[1], (1 - a) * lo[2] + a * hi[2]];
    }
  }
  const [x, y, w] = d[p]!;
  return [x / w, y / w];
}

const segDistance = (p: Vec, a: Vec, b: Vec) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/**
 * Flattens a B-spline whose control points are already in final mm. Without weights each knot span gets
 * enough uniform steps for the bound h²/8 · max|C''|, where |C''| is bounded by the control points of the
 * second-derivative spline (convex hull property). Rational splines start from the same count and are
 * then subdivided wherever a sample strays from its chord.
 */
function flattenBSpline(p: number, knots: number[], ctrl: Vec[], weights: number[] | null, tol: number, budget: PointBudget): Vec[] {
  const n = ctrl.length - 1;
  // Q_i = p(P_{i+1} − P_i)/(u_{i+p+1} − u_{i+1}); R_i = (p−1)(Q_{i+1} − Q_i)/(u_{i+p+1} − u_{i+2}).
  const q: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const den = knots[i + p + 1]! - knots[i + 1]!;
    q.push(den > 0 ? [(p * (ctrl[i + 1]![0] - ctrl[i]![0])) / den, (p * (ctrl[i + 1]![1] - ctrl[i]![1])) / den] : [0, 0]);
  }
  const r: number[] = [];
  for (let i = 0; i + 1 < q.length; i++) {
    const den = knots[i + p + 1]! - knots[i + 2]!;
    r.push(den > 0 && p >= 2 ? ((p - 1) * Math.hypot(q[i + 1]![0] - q[i]![0], q[i + 1]![1] - q[i]![1])) / den : 0);
  }
  const at = (u: number) => deBoor(p, knots, ctrl, weights, u, findSpan(knots, p, n, u));
  const out: Vec[] = [];
  const refine = (ua: number, pa: Vec, ub: number, pb: Vec, depth: number) => {
    const um = (ua + ub) / 2, pm = at(um);
    const off = Math.max(segDistance(pm, pa, pb), segDistance(at((ua + um) / 2), pa, pb), segDistance(at((um + ub) / 2), pa, pb));
    if (depth >= 16 || off <= tol) return;
    budget.take(1);
    refine(ua, pa, um, pm, depth + 1);
    out.push(pm);
    refine(um, pm, ub, pb, depth + 1);
  };
  for (let k = p; k <= n; k++) {
    const u0 = knots[k]!, u1 = knots[k + 1]!;
    if (!(u1 > u0)) continue;
    // On span k, C'' mixes R_{k−p} … R_{k−2}.
    let d2 = 0;
    for (let i = Math.max(0, k - p); i <= k - 2 && i < r.length; i++) d2 = Math.max(d2, r[i]!);
    const h = u1 - u0;
    const steps = Math.max(weights ? 4 : 1, chordsFor(h * h * d2, tol));
    budget.take(steps + 1);
    let prevU = u0, prev = at(u0);
    if (!out.length) out.push(prev);
    for (let s = 1; s <= steps; s++) {
      const u = s === steps ? u1 : u0 + (h * s) / steps;
      const pt = deBoor(p, knots, ctrl, weights, u, k);
      if (weights) refine(prevU, prev, u, pt, 0);
      out.push(pt);
      [prevU, prev] = [u, pt];
    }
  }
  return out;
}

/** A smooth curve through fit points (uniform Catmull-Rom as cubic Béziers), in final mm. */
function throughFitPoints(fit: Vec[], closed: boolean, tol: number, budget: PointBudget): Vec[] {
  const m = fit.length;
  const pt = (i: number): Vec => {
    if (closed) return fit[((i % m) + m) % m]!;
    if (i < 0) return [2 * fit[0]![0] - fit[1]![0], 2 * fit[0]![1] - fit[1]![1]];
    if (i >= m) return [2 * fit[m - 1]![0] - fit[m - 2]![0], 2 * fit[m - 1]![1] - fit[m - 2]![1]];
    return fit[i]!;
  };
  const out: Vec[] = [fit[0]!];
  for (let i = 0; i < (closed ? m : m - 1); i++) {
    const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2);
    const c1: Vec = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Vec = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    flattenCubic(out, p1, c1, c2, p2, tol, budget);
  }
  if (closed) out.pop();
  return out;
}

// ---------------------------------------------------------------- chaining

/** Joins pieces whose ends are within `tol`; chains that come back to their start are closed rings. */
function chainPieces(pieces: Vec[][], tol: number): { closed: Vec[][]; open: Vec[][] } {
  const list = pieces.filter(p => p.length >= 2);
  const end = (ref: number): Vec => (ref & 1 ? list[ref >> 1]!.at(-1)! : list[ref >> 1]![0]!);
  const cellOf = (v: number) => Math.floor(v / tol);
  // Ends hashed on a tol-sized grid: a match is always in the same or a neighbouring cell.
  const grid = new Map<string, number[]>();
  list.forEach((_, i) => {
    for (const ref of [i * 2, i * 2 + 1]) {
      const p = end(ref), key = `${cellOf(p[0])},${cellOf(p[1])}`;
      const cell = grid.get(key);
      if (cell) cell.push(ref);
      else grid.set(key, [ref]);
    }
  });
  const used = new Uint8Array(list.length);
  const near = (p: Vec): number => {
    const cx = cellOf(p[0]), cy = cellOf(p[1]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const ref of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (used[ref >> 1]) continue;
        const q = end(ref);
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol) return ref;
      }
    }
    return -1;
  };
  const meets = (pts: Vec[]) => Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]) <= tol;
  const closed: Vec[][] = [], open: Vec[][] = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = list[i]!.slice();
    // Grow the end, then reverse and grow the other end the same way (the second reverse restores the order).
    for (let side = 0; side < 2; side++) {
      while (!(pts.length > 2 && meets(pts))) {
        const ref = near(pts.at(-1)!);
        if (ref < 0) break;
        used[ref >> 1] = 1;
        const next = list[ref >> 1]!;
        const seq = ref & 1 ? next.slice().reverse() : next;
        for (let k = 1; k < seq.length; k++) pts.push(seq[k]!);
      }
      pts.reverse();
    }
    if (pts.length > 3 && meets(pts)) closed.push(pts.slice(0, -1));
    else open.push(pts);
  }
  return { closed, open };
}

// ---------------------------------------------------------------- reader

type Block = { base: Vec; flags: number; entities: Rec[] };

/** Entities that carry no outline and need no warning. */
const QUIET = new Set(["POINT", "SEQEND", "VERTEX", "VIEWPORT", "ENDBLK"]);

class DxfReader {
  readonly closed: Vec[][] = [];
  readonly open: Vec[][] = [];
  private readonly blocks = new Map<string, Block>();
  private readonly hiddenLayers = new Set<string>();
  private readonly budget = new PointBudget();
  private readonly skipped = new Map<string, number>();
  private readonly n = { hiddenLayer: 0, invisible: 0, paperSpace: 0, missingBlock: 0, loopBlock: 0, xref: 0, mesh: 0, badKnots: 0, emptySpline: 0, openSpline: 0 };
  private readonly notes: string[] = [];

  constructor(private readonly tol: number) {}

  read(text: string): { closed: Vec[][]; open: Vec[][] } {
    const recs = records(readGroups(text));
    const sections = new Map<string, { head: Rec; body: Rec[] }>();
    let body: Rec[] | null = null;
    for (const r of recs) {
      if (r.type === "SECTION") sections.set(r.str(2) ?? "", { head: r, body: (body = []) });
      else if (r.type === "ENDSEC") body = null;
      else if (r.type === "EOF") break;
      else body?.push(r);
    }
    if (!sections.size) throw new ArtImportError("not a valid DXF file: it has no SECTION");

    // Header variables are (9, $NAME) followed by their value groups, all inside the SECTION record.
    const header = sections.get("HEADER")?.head.groups ?? [];
    const at = header.findIndex(g => g.code === 9 && g.value === "$INSUNITS");
    const unitGroup = at >= 0 ? header.slice(at + 1).find(g => g.code === 70) : undefined;
    const units = unitGroup ? toNumber(unitGroup) : 0;
    let mm = UNITS_MM[units];
    if (mm === undefined) {
      this.notes.push(`The drawing units (code ${units}) are not supported; read as millimetres`);
      mm = 1;
    }

    for (const r of sections.get("TABLES")?.body ?? []) {
      if (r.type !== "LAYER") continue;
      // A negative colour means the layer is off; flag 1 means frozen.
      if (r.num(62, 7) < 0 || (r.num(70) & 1) === 1) this.hiddenLayers.add(r.str(2) ?? "");
    }

    let block: Block | null = null;
    for (const r of sections.get("BLOCKS")?.body ?? []) {
      if (r.type === "BLOCK") {
        block = { base: [r.num(10), r.num(20)], flags: r.num(70), entities: [] };
        this.blocks.set(r.str(2) ?? "", block);
      } else if (r.type === "ENDBLK") block = null;
      else block?.entities.push(r);
    }

    const entities = sections.get("ENTITIES")?.body;
    if (!entities) this.notes.push("The drawing has no ENTITIES section");
    else this.entities(entities, scale(mm), []);
    return chainPieces(this.open, CHAIN_TOLERANCE_MM);
  }

  /** Walks a list of entities; `m` maps their coordinates to final mm. */
  private entities(list: Rec[], m: Mat, chain: string[]) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      // A POLYLINE owns the VERTEX records after it; an INSERT with attributes owns ATTRIBs. Both end with SEQEND.
      const owned: Rec[] = [];
      if (r.type === "POLYLINE" || (r.type === "INSERT" && r.num(66) === 1)) {
        while (list[i + 1]?.type === "VERTEX" || list[i + 1]?.type === "ATTRIB") owned.push(list[++i]!);
        if (list[i + 1]?.type === "SEQEND") i++;
      }
      if (QUIET.has(r.type)) continue;
      if (this.hiddenLayers.has(r.str(8) ?? "0")) {
        this.n.hiddenLayer++;
        continue;
      }
      if (r.num(60) === 1) {
        this.n.invisible++;
        continue;
      }
      if (r.num(67) === 1) {
        this.n.paperSpace++;
        continue;
      }
      this.entity(r, owned, m, chain);
    }
  }

  private entity(r: Rec, owned: Rec[], m: Mat, chain: string[]) {
    const { tol, budget } = this;
    // CIRCLE, ARC, LWPOLYLINE, POLYLINE and INSERT are in object coordinates: mirrored when extruded along −Z.
    const ocs = r.num(230, 1) < 0 ? mul(m, MIRROR_X) : m;
    switch (r.type) {
      case "LINE": {
        const a = apply(m, [r.num(10), r.num(20)]), b = apply(m, [r.num(11), r.num(21)]);
        budget.take(2);
        if (a[0] !== b[0] || a[1] !== b[1]) this.open.push([a, b]);
        return;
      }
      case "LWPOLYLINE": {
        const verts: PolyVertex[] = [];
        for (const g of r.groups) {
          if (g.code === 10) verts.push({ p: [toNumber(g), 0], bulge: 0 });
          else if (g.code === 20 && verts.length) verts.at(-1)!.p[1] = toNumber(g);
          else if (g.code === 42 && verts.length) verts.at(-1)!.bulge = toNumber(g);
        }
        return this.polyline(verts, (r.num(70) & 1) === 1, ocs);
      }
      case "POLYLINE": {
        const flags = r.num(70);
        if (flags & (16 | 64)) {
          this.n.mesh++;
          return;
        }
        // Vertices flagged 16 are the frame of a spline-fit polyline, not points on it.
        const verts = owned.filter(v => v.type === "VERTEX" && !(v.num(70) & 16)).map(v => ({ p: [v.num(10), v.num(20)] as Vec, bulge: v.num(42) }));
        return this.polyline(verts, (flags & 1) === 1, flags & 8 ? m : ocs);
      }
      case "CIRCLE": {
        const rad = r.num(40);
        if (!(rad > 0)) return;
        const pts = arcPoints(ocs, [r.num(10), r.num(20)], rad, 0, 2 * Math.PI, tol, budget, true);
        pts.pop(); // the last point repeats the first
        this.closed.push(pts);
        return;
      }
      case "ARC": {
        const rad = r.num(40);
        if (!(rad > 0)) return;
        const a0 = r.num(50), a1 = r.num(51);
        let sweep = (((a1 - a0) % 360) + 360) % 360; // counter-clockwise from start to end
        if (sweep === 0) sweep = 360;
        this.open.push(arcPoints(ocs, [r.num(10), r.num(20)], rad, (a0 * Math.PI) / 180, (sweep * Math.PI) / 180, tol, budget, true));
        return;
      }
      case "ELLIPSE":
        return this.ellipse(r, m);
      case "SPLINE":
        return this.spline(r, m);
      case "INSERT":
        return this.insert(r, ocs, chain);
      default:
        this.skipped.set(r.type, (this.skipped.get(r.type) ?? 0) + 1);
    }
  }

  private polyline(verts: PolyVertex[], closed: boolean, m: Mat) {
    // Drop repeated vertices, keeping the bulge of the segment that follows them; a closed polyline often
    // repeats its first vertex at the end.
    const same = (a: PolyVertex, b: PolyVertex) => a.p[0] === b.p[0] && a.p[1] === b.p[1];
    const v: PolyVertex[] = [];
    for (const x of verts) {
      const last = v.at(-1);
      if (last && same(last, x)) last.bulge = x.bulge;
      else v.push({ p: x.p, bulge: x.bulge });
    }
    if (closed && v.length > 1 && same(v[0]!, v.at(-1)!)) v.pop();
    if (v.length < 2) return;
    const pts = polylinePoints(v, closed, m, this.tol, this.budget);
    if (closed && pts.length >= 3) this.closed.push(pts);
    else this.open.push(closed ? [...pts, pts[0]!] : pts);
  }

  /** ELLIPSE: centre and major axis end point in world coordinates, ratio of minor to major, start/end parameters. */
  private ellipse(r: Rec, m: Mat) {
    const c: Vec = [r.num(10), r.num(20)];
    const major: Vec = [r.num(11), r.num(21)];
    const ratio = r.num(40, 1);
    const len = Math.hypot(major[0], major[1]);
    if (!(len > 0 && ratio > 0)) return;
    // The minor axis is extrusion × major, so it flips with a −Z extrusion.
    const z = r.num(230, 1) < 0 ? -1 : 1;
    const minor: Vec = [-z * major[1] * ratio, z * major[0] * ratio];
    const t0 = r.num(41, 0), t1 = r.num(42, 2 * Math.PI);
    let sweep = (((t1 - t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const whole = sweep < 1e-9 || Math.abs(sweep - 2 * Math.PI) < 1e-9;
    if (whole) sweep = 2 * Math.PI;
    const n = arcSteps(maxScale(m) * len, sweep, this.tol);
    this.budget.take(n + 1);
    const pts: Vec[] = [];
    for (let i = 0; i <= (whole ? n - 1 : n); i++) {
      const t = t0 + (sweep * i) / n, cos = Math.cos(t), sin = Math.sin(t);
      pts.push(apply(m, [c[0] + major[0] * cos + minor[0] * sin, c[1] + major[1] * cos + minor[1] * sin]));
    }
    (whole ? this.closed : this.open).push(pts);
  }

  /** SPLINE: degree (71), knots (40), weights (41), control points (10/20); fit points (11/21) when there are no control points. */
  private spline(r: Rec, m: Mat) {
    const p = r.num(71, 3);
    const flags = r.num(70);
    const ctrl = r.points(10).map(v => apply(m, v)); // B-splines are affine invariant: transform the control points
    const fit = r.points(11).map(v => apply(m, v));
    let pts: Vec[];
    if (p >= 1 && Number.isInteger(p) && ctrl.length > p) {
      let knots = r.nums(40);
      const ordered = knots.every((k, i) => i === 0 || k >= knots[i - 1]!);
      if (knots.length !== ctrl.length + p + 1 || !ordered || !(knots[ctrl.length]! > knots[p]!)) {
        // Clamped uniform knots: the curve starts and ends on the end control points.
        this.n.badKnots++;
        const inner = ctrl.length - p;
        knots = [...Array<number>(p + 1).fill(0), ...Array.from({ length: inner - 1 }, (_, i) => i + 1), ...Array<number>(p + 1).fill(inner)];
      }
      const w = r.nums(41);
      const rational = w.length === ctrl.length && w.every(x => x > 0) && w.some(x => Math.abs(x - 1) > 1e-12);
      pts = flattenBSpline(p, knots, ctrl, rational ? w : null, this.tol, this.budget);
    } else if (fit.length >= 2) {
      pts = throughFitPoints(fit, (flags & 1) === 1 && fit.length > 2, this.tol, this.budget);
      if ((flags & 1) === 1 && pts.length >= 3) {
        this.closed.push(pts);
        return;
      }
    } else {
      this.n.emptySpline++;
      return;
    }
    const start = pts[0]!, end = pts.at(-1)!;
    const meets = Math.hypot(end[0] - start[0], end[1] - start[1]) <= CHAIN_TOLERANCE_MM;
    if ((flags & 1) === 1 && !meets && pts.length >= 3) {
      // Flagged closed but the ends do not meet: close it with a straight segment.
      this.n.openSpline++;
      this.closed.push(pts);
    } else this.open.push(pts);
  }

  /** INSERT: a block placed at 10/20, scaled by 41/42, rotated by 50 degrees, optionally as a grid (70/71 counts, 44/45 spacing). */
  private insert(r: Rec, m: Mat, chain: string[]) {
    const name = r.str(2) ?? "";
    const block = this.blocks.get(name);
    if (!block) {
      this.n.missingBlock++;
      return;
    }
    if (block.flags & 4) {
      this.n.xref++;
      return;
    }
    if (chain.includes(name) || chain.length >= MAX_INSERT_DEPTH) {
      this.n.loopBlock++;
      return;
    }
    const cols = Math.max(1, Math.trunc(r.num(70, 1))), rows = Math.max(1, Math.trunc(r.num(71, 1)));
    if (cols * rows > 100_000) throw new ArtImportError(`an INSERT places block "${name}" ${cols * rows} times; that is too many`);
    const place = mul(translate(r.num(10), r.num(20)), rotate(r.num(50)));
    const local = mul(scale(r.num(41, 1), r.num(42, 1)), translate(-block.base[0], -block.base[1]));
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const at = mul(place, mul(translate(col * r.num(44), row * r.num(45)), local));
        this.entities(block.entities, mul(m, at), [...chain, name]);
      }
    }
  }

  warnings(): string[] {
    const out = [...this.notes];
    if (this.skipped.size) {
      const total = [...this.skipped.values()].reduce((a, b) => a + b, 0);
      const list = [...this.skipped].sort((a, b) => b[1] - a[1]).map(([type, k]) => `${k} ${type}`).join(", ");
      out.push(`${count(total, "entity", "entities")} skipped (${list}): only lines, arcs, circles, ellipses, polylines and splines can be marked; explode text, hatches and dimensions into outlines first`);
    }
    const n = this.n;
    if (n.hiddenLayer) out.push(`${count(n.hiddenLayer, "entity", "entities")} skipped: on a hidden or frozen layer`);
    if (n.invisible) out.push(`${count(n.invisible, "invisible entity", "invisible entities")} skipped`);
    if (n.paperSpace) out.push(`${count(n.paperSpace, "paper-space entity", "paper-space entities")} skipped: only model space is marked`);
    if (n.missingBlock) out.push(`${count(n.missingBlock, "block reference")} skipped: the block is missing`);
    if (n.xref) out.push(`${count(n.xref, "external reference")} skipped: bind it into the drawing first`);
    if (n.loopBlock) out.push(`${count(n.loopBlock, "block reference")} skipped: the block contains itself`);
    if (n.mesh) out.push(`${count(n.mesh, "3D mesh", "3D meshes")} skipped`);
    if (n.badKnots) out.push(`${count(n.badKnots, "spline")} drawn with uniform knots: the knot list does not match the control points`);
    if (n.emptySpline) out.push(`${count(n.emptySpline, "spline")} skipped: it has no control points or fit points`);
    if (n.openSpline) out.push(`${count(n.openSpline, "spline")} closed with a straight segment: it is marked closed but its ends do not meet`);
    return out;
  }
}

/**
 * Reads ASCII DXF text. Units come from $INSUNITS (inches, mm, cm, m…; unitless or missing = mm).
 * Throws {@link ArtImportError} for text that is not DXF (or is binary DXF).
 */
export async function importDxf(text: string, opts?: { toleranceMm?: number }): Promise<ArtGeometry> {
  const tol = toleranceOf(opts);
  if (!text.trim()) return finish([], [], ["The file is empty."]);
  if (text.startsWith("AutoCAD Binary DXF")) throw new ArtImportError("binary DXF is not supported: save the drawing as ASCII DXF");
  const reader = new DxfReader(tol);
  const chains = reader.read(text);
  return finish([{ rings: [...reader.closed, ...chains.closed], rule: "EvenOdd" }], chains.open, reader.warnings());
}

