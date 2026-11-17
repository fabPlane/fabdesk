/**
 * Score a placement before routing (port of the toolkit's `tools/placement_check.py`):
 *
 *   hpwl        half-perimeter wirelength of every net with 2+ pads (the ground net and `unconnected-*` excluded: ground
 *               drops to planes), total and per block (`BLOCKS.json`: a net counts for the block owning most of its pads)
 *   rotation    each movable part with `minPads`+ pads: the HPWL of its nets at each of the four turns about its origin,
 *               the rest fixed; flagged when the best turn saves >= 15 % of its own nets' HPWL (a part facing away from
 *               what it connects to). Fixed parts (connectors, switches, mechanical) are not candidates.
 *   congestion  RUDY (each net's bounding box spreads its HPWL over the box) on a `cell` grid, mm of wire per mm2: the
 *               top cells and the count above 2.0
 *   via_sites   through-via availability: a 0.5 mm grid cell is a site when a 0.5 mm via there clears every pad (true
 *               pad rectangle + 0.1 mm) and the board edge (0.6 mm); the free share near each signal net's pads (1.5 mm),
 *               the worst nets and the free share per 10 mm cell. Stacked F/B connectors and ICs leave no sites, which
 *               RUDY cannot see.
 *
 * The toolkit hard-coded C6 (outline 74.9 x 65.4 mm at the origin, ground `IO_GND`, fixed `_(J|SW)\d|^FIT_`); here they
 * are options: the board's Edge.Cuts box, its ground net, the layout spec's fixed pattern. Arithmetic follows the Python
 * operation for operation (radians as `deg * (pi/180)`, float floor division, round half even), so the numbers are the
 * toolkit's on the same inputs (test/parity-placement.ts).
 */
import { pyRound } from "../accept";
import { kid, kids, parseSexpr, type SNode } from "../sexpr";

export interface PlacementOptions {
  /** `BLOCKS.json` content (block name -> {parts}); adds `hpwl_by_block_mm`. */
  blocks?: Record<string, { parts: string[] }>;
  /** Parts with fewer pads are not rotation candidates (default 8). */
  minPads?: number;
  /** RUDY grid cell, mm (default 2.0). */
  cell?: number;
  /** References that are never rotation candidates (default: the toolkit's C6 pattern). */
  fixed?: RegExp;
  /** Nets left out of every figure (default `^GROUND$|^unconnected-` for `ground`, else the toolkit's `^IO_GND$|^unconnected-`). */
  skip?: RegExp;
  /** The board's ground net (builds `skip` when `skip` is not given). */
  ground?: string;
  /** Board box [x0, y0, x1, y1] for the via-site grid (default: the Edge.Cuts box, else C6's 0,0,74.9,65.4). */
  outline?: [number, number, number, number];
  /** Label for the `board` field. */
  board?: string;
}

export interface RotationRow {
  ref: string;
  rot: number;
  pads: number;
  hpwl_now_mm: number;
  best_turn_deg: number;
  hpwl_best_mm: number;
  saving: number;
  flag: boolean;
}

export interface PlacementReport {
  board: string;
  hpwl_total_mm: number;
  nets: number;
  hpwl_by_block_mm?: Record<string, number>;
  rotation: { flagged: RotationRow[]; checked: number; all: RotationRow[] };
  congestion: { cell_mm: number; max: number; cells_over_2: number; cells: number; top: Array<{ x: number; y: number; rudy: number }> };
  via_sites: {
    free_fraction: number;
    nets_under_10pct: number;
    nets_under_20pct: number;
    mean_net_free: number;
    worst_nets: Array<[string, number]>;
    free_by_10mm_cell: Record<string, number>;
  };
}

export const C6_FIXED = /_(J|SW)\d|^FIT_/;
const DEG = Math.PI / 180; // math.radians(x) is x * (pi / 180)

interface MFp {
  x: number;
  y: number;
  rot: number;
  layer: string;
  node: SNode;
  pins: Record<string, string>;
}
interface MPad {
  ref: string;
  net: string;
  x: number;
  y: number;
}

const f = (x: unknown) => Number(x);

/** check_acceptance.board_model: footprints (last definition of a reference wins, first position kept) and netted pads. */
function model(root: SNode): { fps: Map<string, MFp>; pads: MPad[] } {
  const fps = new Map<string, MFp>();
  const pads: MPad[] = [];
  for (const fp of kids(root, "footprint")) {
    const tr = kid(fp, "transform");
    let x: number, y: number, rot: number;
    if (tr) {
      const t = kid(tr, "translate")!;
      [x, y] = [f(t[1]), f(t[2])];
      const r = kid(tr, "rotate");
      rot = r ? f(r[1]) : 0;
    } else {
      const at = kid(fp, "at")!;
      [x, y, rot] = [f(at[1]), f(at[2]), at.length > 3 ? f(at[3]) : 0];
    }
    let ref: string | undefined;
    for (const p of kids(fp, "property")) if (p[1] === "Reference") ref = String(p[2]);
    const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
    const pins: Record<string, string> = {};
    for (const pad of kids(fp, "pad")) {
      const net = kid(pad, "net");
      if (!net) continue;
      const name = String(net[net.length - 1]);
      pins[String(pad[1])] = name;
      const at = kid(pad, "at")!;
      const px = f(at[1]), py = f(at[2]);
      pads.push({ ref: ref!, net: name, x: x + px * c + py * s, y: y - px * s + py * c });
    }
    fps.set(ref!, { x, y, rot: pyMod(rot, 360), layer: String(kid(fp, "layer")?.[1] ?? ""), node: fp, pins });
  }
  return { fps, pads };
}

/** Python's float `%` (the result takes the divisor's sign). */
export function pyMod(x: number, m: number): number {
  const r = x % m;
  return r !== 0 && r < 0 !== m < 0 ? r + m : r;
}

/** Python's float floor division `x // y` (CPython float_floor_div: fmod-based, then rounded to the nearest integer). */
export function pyFloorDiv(x: number, y: number): number {
  let mod = x % y;
  let div = (x - mod) / y;
  if (mod && y < 0 !== mod < 0) {
    mod += y;
    div -= 1;
  }
  if (!div) return x / y < 0 ? -0 : 0;
  let fl = Math.floor(div);
  if (div - fl > 0.5) fl += 1;
  return fl;
}

function hpwl(pts: Array<[number, number]>): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 - x0 + (y1 - y0);
}

const sum = (xs: Iterable<number>) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

/** Stable sort by key (Python's `sorted(key=...)`). */
const sortedBy = <T>(xs: T[], key: (x: T) => number) => xs.map((x, i) => ({ x, i, k: key(x) })).sort((a, b) => a.k - b.k || a.i - b.i).map((e) => e.x);

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Edge.Cuts bounding box of a parsed board, or null. */
function edgeBox(root: SNode): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
  for (const g of root) {
    if (!Array.isArray(g) || typeof g[0] !== "string" || !/^gr_(line|rect|arc|circle|poly|curve)$/.test(g[0])) continue;
    if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
    if (g[0] === "gr_circle") {
      const c = kid(g, "center")!, e = kid(g, "end")!;
      const rr = Math.hypot(f(e[1]) - f(c[1]), f(e[2]) - f(c[2]));
      add(f(c[1]) - rr, f(c[2]) - rr);
      add(f(c[1]) + rr, f(c[2]) + rr);
      continue;
    }
    for (const k of ["start", "mid", "end"]) {
      const n = kid(g, k);
      if (n) add(f(n[1]), f(n[2]));
    }
    for (const pts of kids(g, "pts")) for (const q of kids(pts, "xy")) add(f(q[1]), f(q[2]));
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** `placement_check.py` on a board text. */
export function placementCheck(text: string, o: PlacementOptions = {}): PlacementReport {
  const root = parseSexpr(text);
  const { fps, pads } = model(root);
  const minPads = o.minPads ?? 8;
  const cell = o.cell ?? 2.0;
  const FIXED = o.fixed ?? C6_FIXED;
  const SKIP = o.skip ?? new RegExp(`^${reEscape(o.ground ?? "IO_GND")}$|^unconnected-`);
  const all = new Map<string, MPad[]>();
  for (const p of pads) if (!SKIP.test(p.net)) (all.get(p.net) ?? all.set(p.net, []).get(p.net)!).push(p);
  const nets = new Map([...all].filter(([, ps]) => ps.length > 1));
  const wl = new Map([...nets].map(([n, ps]) => [n, hpwl(ps.map((p) => [p.x, p.y]))]));
  const out: PlacementReport = { board: o.board ?? "", hpwl_total_mm: pyRound(sum(wl.values()), 1), nets: wl.size } as PlacementReport;
  if (o.blocks) {
    const owner = new Map<string, string>();
    for (const [b, v] of Object.entries(o.blocks)) for (const r of v.parts) owner.set(r, b);
    const per = new Map<string, number>();
    for (const [n, ps] of nets) {
      const c = new Map<string, number>();
      for (const p of ps) {
        const b = owner.get(p.ref) ?? "?";
        c.set(b, (c.get(b) ?? 0) + 1);
      }
      let best = "", bv = -1;
      for (const [b, k] of c) if (k > bv) ((best = b), (bv = k)); // Counter.most_common(1): the first of the largest
      per.set(best, (per.get(best) ?? 0) + wl.get(n)!);
    }
    out.hpwl_by_block_mm = Object.fromEntries(sortedBy([...per], ([, v]) => -v).map(([b, v]) => [b, pyRound(v, 1)]));
  }
  // rotation
  const byRef = new Map<string, MPad[]>();
  for (const p of pads) (byRef.get(p.ref) ?? byRef.set(p.ref, []).get(p.ref)!).push(p);
  let rot: RotationRow[] = [];
  for (const [ref, fp] of fps) {
    const own = byRef.get(ref) ?? [];
    if (FIXED.test(ref) || own.length < minPads) continue;
    const mine = [...new Set(own.map((p) => p.net).filter((n) => nets.has(n)))];
    if (!mine.length) continue;
    const cost = new Map<number, number>();
    for (const d of [0, 90, 180, 270]) {
      const c = Math.cos(d * DEG), s = Math.sin(d * DEG);
      const moved = new Map<MPad, [number, number]>();
      for (const p of own) {
        // KiCad y points down; a positive angle turns counter-clockwise on screen
        const dx = p.x - fp.x, dy = p.y - fp.y;
        moved.set(p, [fp.x + dx * c + dy * s, fp.y - dx * s + dy * c]);
      }
      cost.set(d, sum(mine.map((n) => hpwl(nets.get(n)!.map((p) => moved.get(p) ?? [p.x, p.y])))));
    }
    // min() keeps the first of equal costs; a turn that only reorders the same sum differs in the last bit (the toolkit sums
    // over a set, in hash order), so equal means within 1e-9 mm
    let best = 0;
    for (const d of [90, 180, 270]) if (cost.get(d)! < cost.get(best)! - 1e-9) best = d;
    const c0 = cost.get(0)!, cb = cost.get(best)!;
    const gain = c0 ? 1 - cb / c0 : 0;
    rot.push({ ref, rot: pyMod(fp.rot, 360), pads: own.length, hpwl_now_mm: pyRound(c0, 1), best_turn_deg: best, hpwl_best_mm: pyRound(cb, 1), saving: pyRound(gain, 3), flag: best !== 0 && gain >= 0.15 });
  }
  rot = sortedBy(rot, (r) => -r.saving);
  out.rotation = { flagged: rot.filter((r) => r.flag), checked: rot.length, all: rot };
  // congestion (RUDY)
  const grid = new Map<string, { i: number; j: number; v: number }>();
  for (const ps of nets.values()) {
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = Math.max(x1 - x0, cell), h = Math.max(y1 - y0, cell);
    const dens = (w + h) / (w * h);
    const xe = x1 > x0 ? x1 : x0 + cell, ye = y1 > y0 ? y1 : y0 + cell;
    for (let i = Math.trunc(pyFloorDiv(x0, cell)); i < Math.trunc(pyFloorDiv(x1, cell)) + 1; i++)
      for (let j = Math.trunc(pyFloorDiv(y0, cell)); j < Math.trunc(pyFloorDiv(y1, cell)) + 1; j++) {
        const ox = Math.max(0, Math.min(xe, (i + 1) * cell) - Math.max(x0, i * cell));
        const oy = Math.max(0, Math.min(ye, (j + 1) * cell) - Math.max(y0, j * cell));
        const k = `${i},${j}`;
        const e = grid.get(k) ?? grid.set(k, { i, j, v: 0 }).get(k)!;
        e.v += (dens * ox * oy) / (cell * cell);
      }
  }
  const cells = sortedBy([...grid.values()], (e) => -e.v);
  out.congestion = {
    cell_mm: cell,
    max: cells.length ? pyRound(cells[0]!.v, 2) : 0,
    cells_over_2: cells.filter((e) => e.v > 2.0).length,
    cells: cells.length,
    top: cells.slice(0, 12).map((e) => ({ x: pyRound((e.i + 0.5) * cell, 1), y: pyRound((e.j + 0.5) * cell, 1), rudy: pyRound(e.v, 2) })),
  };
  out.via_sites = viaSites(root, fps, [...nets.keys()], o.outline ?? edgeBox(root) ?? [0, 0, 74.9, 65.4]);
  return out;
}

/** placement_check.via_sites: cell 0.5, via 0.5, clearance 0.1. */
function viaSites(root: SNode, fps: Map<string, MFp>, nets: string[], [X0, Y0, X1, Y1]: [number, number, number, number], cell = 0.5, via = 0.5, clearance = 0.1): PlacementReport["via_sites"] {
  const nx = Math.trunc((X1 - X0) / cell), ny = Math.trunc((Y1 - Y0) / cell);
  const gx = Array.from({ length: nx }, (_, i) => X0 + (i + 0.5) * cell);
  const gy = Array.from({ length: ny }, (_, j) => Y0 + (j + 0.5) * cell);
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) free[j * nx + i] = gx[i]! > X0 + 0.6 && gx[i]! < X1 - 0.6 && gy[j]! > Y0 + 0.6 && gy[j]! < Y1 - 0.6 ? 1 : 0;
  // grid index range a box [a, b] can touch (a superset; the exact test decides)
  const span = (a: number, b: number, o0: number, n: number): [number, number] => [Math.max(0, Math.floor((a - o0) / cell) - 1), Math.min(n - 1, Math.ceil((b - o0) / cell) + 1)];
  const padPts = new Map<string, Array<[number, number]>>();
  for (const fp of kids(root, "footprint")) {
    let ref = "";
    for (const p of kids(fp, "property")) if (p[1] === "Reference") ref = String(p[2]);
    const F = fps.get(ref)!;
    const c = Math.cos(F.rot * DEG), s = Math.sin(F.rot * DEG);
    for (const pd of kids(fp, "pad")) {
      const at = kid(pd, "at"), size = kid(pd, "size"), net = kid(pd, "net");
      if (!(at && size)) continue;
      const px = f(at[1]), py = f(at[2]);
      const wx = F.x + px * c + py * s, wy = F.y - px * s + py * c;
      const ang = (at.length > 3 ? f(at[3]) : F.rot) * DEG;
      const hw = f(size[1]) / 2 + via / 2 + clearance, hh = f(size[2]) / 2 + via / 2 + clearance;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const R = Math.hypot(hw, hh) + 1e-6;
      const [i0, i1] = span(wx - R, wx + R, X0, nx), [j0, j1] = span(wy - R, wy + R, Y0, ny);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const dx = gx[i]! - wx, dy = gy[j]! - wy;
          const u = dx * ca - dy * sa, v = dx * sa + dy * ca;
          if (Math.abs(u) <= hw && Math.abs(v) <= hh) free[j * nx + i] = 0;
        }
      if (net) {
        const n = String(net[net.length - 1]);
        (padPts.get(n) ?? padPts.set(n, []).get(n)!).push([wx, wy]);
      }
    }
  }
  const perNet = new Map<string, number>();
  const near = new Uint8Array(nx * ny);
  for (const n of nets) {
    near.fill(0);
    let any = false;
    for (const [x, y] of padPts.get(n) ?? []) {
      const [i0, i1] = span(x - 1.5, x + 1.5, X0, nx), [j0, j1] = span(y - 1.5, y + 1.5, Y0, ny);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++)
          if ((gx[i]! - x) ** 2 + (gy[j]! - y) ** 2 <= 1.5 ** 2) {
            near[j * nx + i] = 1;
            any = true;
          }
    }
    if (!any) continue;
    let k = 0, fr = 0;
    for (let q = 0; q < near.length; q++) if (near[q]) ((k += 1), (fr += free[q]!));
    perNet.set(n, pyRound(fr / k, 3));
  }
  const worst = sortedBy([...perNet], ([, v]) => v).slice(0, 15);
  const blocks: Record<string, number> = {};
  for (let j = 0; j < ny; j += 20)
    for (let i = 0; i < nx; i += 20) {
      let k = 0, fr = 0;
      for (let jj = j; jj < Math.min(ny, j + 20); jj++) for (let ii = i; ii < Math.min(nx, i + 20); ii++) ((k += 1), (fr += free[jj * nx + ii]!));
      blocks[`${pyRound(X0 + i * cell, 0).toFixed(0)},${pyRound(Y0 + j * cell, 0).toFixed(0)}`] = pyRound(fr / k, 3);
    }
  const vals = [...perNet.values()];
  return {
    free_fraction: pyRound(sum(free) / free.length, 3),
    nets_under_10pct: vals.filter((v) => v < 0.1).length,
    nets_under_20pct: vals.filter((v) => v < 0.2).length,
    mean_net_free: pyRound(npMean(vals), 3),
    worst_nets: worst,
    free_by_10mm_cell: blocks,
  };
}

/** numpy's float64 mean (pairwise summation in blocks of 8 below 128 elements, recursive above). */
function npMean(xs: number[]): number {
  return pairwise(xs, 0, xs.length) / xs.length;
}
function pairwise(a: number[], lo: number, n: number): number {
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r += a[lo + i]!;
    return r;
  }
  if (n <= 128) {
    const r = [a[lo]!, a[lo + 1]!, a[lo + 2]!, a[lo + 3]!, a[lo + 4]!, a[lo + 5]!, a[lo + 6]!, a[lo + 7]!];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let k = 0; k < 8; k++) r[k]! += a[lo + i + k]!;
    let res = r[0]! + r[1]! + (r[2]! + r[3]!) + (r[4]! + r[5]! + (r[6]! + r[7]!));
    for (; i < n; i++) res += a[lo + i]!;
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(a, lo, n2) + pairwise(a, lo + n2, n - n2);
}

/** One line per finding, for the agent. */
export function placementLines(r: PlacementReport): string[] {
  const v = r.via_sites;
  const lines = [
    `HPWL ${r.hpwl_total_mm} mm over ${r.nets} nets; RUDY max ${r.congestion.max} (${r.congestion.cells_over_2} of ${r.congestion.cells} cells over 2.0 at ${r.congestion.cell_mm} mm)`,
    `via sites: ${v.free_fraction} of the board free; ${v.nets_under_10pct} nets < 10 %, ${v.nets_under_20pct} nets < 20 % free near their pads (mean ${v.mean_net_free}); worst ${v.worst_nets.slice(0, 6).map(([n, x]) => `${n} ${x}`).join(", ")}`,
  ];
  if (r.hpwl_by_block_mm) lines.push(`HPWL by block: ${Object.entries(r.hpwl_by_block_mm).slice(0, 8).map(([b, x]) => `${b} ${x}`).join(", ")}`);
  lines.push(
    r.rotation.flagged.length
      ? `rotation: ${r.rotation.flagged.map((x) => `${x.ref} turn ${x.best_turn_deg} saves ${Math.round(x.saving * 100)} % (${x.hpwl_now_mm} -> ${x.hpwl_best_mm} mm)`).join("; ")} (of ${r.rotation.checked} checked)`
      : `rotation: no part saves >= 15 % by turning (${r.rotation.checked} checked)`,
  );
  return lines;
}
