/**
 * Laser copper-removal job for a copper-clad blank (single-sided FR-4 or a Viagrid prefab), made
 * from the native board's copper layer.
 *
 * Reads tracks, arcs, vias, pads, filled zones and copper graphics from `board.kicad_pcb`, unions
 * them, and works out the copper the laser has to remove:
 * - `isolation` (default): a ring `isolationMm` wide around every copper island. Fast, and the
 *   leftover copper is harmless on a hobby board.
 * - `full`: every bit of copper on the board that is not a trace or pad. Slower; cleaner for RF,
 *   fine pitch and easy soldering.
 * Writes a LightBurn `.lbrn2` (fill layer + edge-cleanup layer + guide outline), a filled SVG
 * (even-odd, for ComMarker Studio / EZCAD import) and a JSON summary the laser cell reads.
 *
 * Pure TypeScript (polygon-clipping); does not need kicad-cli.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import type { ManifoldToplevel } from "manifold-3d";
import { solidKernel } from "./enclosure-solid";

export type Vec2 = [number, number];
type Ring = Vec2[];
type Sexpr = string | Sexpr[];

export type CopperSide = "F" | "B";
export type CopperMode = "isolation" | "full";

/** Galvo parameters for one pass type. Starting points, tuned on a coupon. */
export type CopperPassSettings = {
  powerPct: number;
  speedMmPerS: number;
  frequencyKhz: number;
  /** Q-pulse width (ns). UV sources on the Omni X are fixed-pulse; written for LightBurn's field. */
  pulseNs: number;
  passes: number;
  /** Hatch line spacing (fill passes only). */
  intervalMm: number;
  /** Hatch angle of the first pass; later passes add `angleStepDeg` (cross-hatch). */
  angleDeg: number;
  angleStepDeg: number;
};

export type CopperJobSettings = {
  /** Fill passes that ablate the copper. */
  ablate: CopperPassSettings;
  /** Line passes along every copper edge for a clean isolation wall. */
  edge: CopperPassSettings;
  /** Optional final low-power fill that removes the oxide/char film (0 passes = off). */
  clean: CopperPassSettings;
  lensMm: number;
};

export type CopperLaserOptions = {
  side?: CopperSide;
  mode?: CopperMode;
  /** Width of the isolation ring around copper in `isolation` mode. */
  isolationMm?: number;
  /** Mirror the artwork (bottom copper seen from the back). Default: true for B, false for F. */
  mirror?: boolean;
  /** Leave a small copper-free dot at each through-hole pad centre to start the drill. 0 = off. */
  drillMarkMm?: number;
  /** Extra copper-free margin inside the board outline (keeps the edge clean). */
  edgeMarginMm?: number;
  /** Lens preset; default picks the 70 mm lens when the board fits it. */
  preset?: CopperPresetId;
  settings?: Partial<{ ablate: Partial<CopperPassSettings>; edge: Partial<CopperPassSettings>; clean: Partial<CopperPassSettings> }>;
};

export type CopperLaserBuild = {
  side: CopperSide;
  mode: CopperMode;
  mirror: boolean;
  isolationMm: number;
  preset: CopperPresetId;
  /** Board outline bounds in board coordinates (mm, Y down). */
  board: { minX: number; minY: number; maxX: number; maxY: number; widthMm: number; heightMm: number };
  /** Job geometry in job coordinates: origin at the board's bottom-left corner, Y up, mirrored if requested. */
  copper: MultiPolygon;
  ablate: MultiPolygon;
  /** Through-hole pad and via centres (job coordinates). */
  drills: Array<{ x: number; y: number; diameterMm: number; kind: "pad" | "via" }>;
  counts: { tracks: number; arcs: number; vias: number; pads: number; zones: number; graphics: number };
  areaMm2: { board: number; copper: number; ablate: number };
  settings: CopperJobSettings;
  warnings: string[];
};

export class CopperLaserOptionsError extends Error {
  override name = "CopperLaserOptionsError";
}

export const COPPER_PRESET_IDS = ["omni-x-6w-70mm", "omni-x-6w-150mm"] as const;
export type CopperPresetId = (typeof COPPER_PRESET_IDS)[number];

/**
 * Starting points for a ComMarker Omni X UV (355 nm, 6 W) on 35 µm (1 oz) copper-clad FR-4, in focus
 * on the copper (autofocus, 0 offset). Derived from ComMarker's published Omni X tables (metals at
 * 40 kHz / pulse 1 / 0.02 mm, the UV PCB example at 500 mm/s / 0.03 mm) and slowed for 6 W; not a
 * certified recipe. Run Studio's or LightBurn's material-test grid on a scrap of the same blank and
 * check isolation with a continuity meter before a real board. Sources: docs/laser-cell.md.
 *
 * The 70 mm lens (≈70 × 70 mm field) gives a much smaller, hotter spot: use it for boards that fit.
 */
export const COPPER_PRESETS: Record<CopperPresetId, CopperJobSettings & { title: string; fieldMm: number }> = {
  "omni-x-6w-70mm": {
    title: "Omni X 6 W · 70 mm lens (boards up to ~65 mm)",
    fieldMm: 70,
    ablate: { powerPct: 100, speedMmPerS: 500, frequencyKhz: 40, pulseNs: 1, passes: 8, intervalMm: 0.015, angleDeg: 0, angleStepDeg: 90 },
    edge: { powerPct: 100, speedMmPerS: 300, frequencyKhz: 40, pulseNs: 1, passes: 3, intervalMm: 0, angleDeg: 0, angleStepDeg: 0 },
    clean: { powerPct: 40, speedMmPerS: 1500, frequencyKhz: 60, pulseNs: 1, passes: 1, intervalMm: 0.015, angleDeg: 45, angleStepDeg: 0 },
    lensMm: 70,
  },
  "omni-x-6w-150mm": {
    title: "Omni X 6 W · 150 mm lens (boards up to ~145 mm)",
    fieldMm: 150,
    ablate: { powerPct: 100, speedMmPerS: 300, frequencyKhz: 30, pulseNs: 1, passes: 12, intervalMm: 0.02, angleDeg: 0, angleStepDeg: 90 },
    edge: { powerPct: 100, speedMmPerS: 200, frequencyKhz: 30, pulseNs: 1, passes: 4, intervalMm: 0, angleDeg: 0, angleStepDeg: 0 },
    clean: { powerPct: 50, speedMmPerS: 1000, frequencyKhz: 60, pulseNs: 1, passes: 1, intervalMm: 0.02, angleDeg: 45, angleStepDeg: 0 },
    lensMm: 150,
  },
};

const ARC_SEGMENTS_PER_MM = 4;
const CIRCLE_SEGS = 32;

// ---------------------------------------------------------------- s-expression

function parseSexpr(text: string): Sexpr[] {
  const stack: Sexpr[][] = [[]];
  const tokens = /"(?:\\.|[^"\\])*"|[()]|[^\s()"]+/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "(") {
      const list: Sexpr[] = [];
      stack.at(-1)!.push(list);
      stack.push(list);
    } else if (token === ")") {
      if (stack.length === 1) throw new CopperLaserOptionsError("unbalanced parentheses in board file");
      stack.pop();
    } else stack.at(-1)!.push(token.startsWith('"') ? token.slice(1, -1).replace(/\\(.)/g, "$1") : token);
  }
  if (stack.length !== 1) throw new CopperLaserOptionsError("unbalanced parentheses in board file");
  return stack[0]!;
}

const head = (n: Sexpr): string | null => (Array.isArray(n) && typeof n[0] === "string" ? n[0] : null);
const kids = (n: Sexpr[], name: string): Sexpr[][] => n.filter((c): c is Sexpr[] => head(c) === name);
const kid = (n: Sexpr[], name: string): Sexpr[] | undefined => n.find((c): c is Sexpr[] => head(c) === name);
const num = (v: Sexpr | undefined, fallback = 0): number => (typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback);
const point = (n: Sexpr[] | undefined): Vec2 | null => (n ? [num(n[1]), num(n[2])] : null);
const layersOf = (n: Sexpr[]): string[] => [...(kid(n, "layers")?.slice(1) ?? []), ...(kid(n, "layer")?.slice(1, 2) ?? [])].filter((x): x is string => typeof x === "string");

function onCopper(layers: string[], side: CopperSide): boolean {
  const want = `${side}.Cu`;
  return layers.some(l => l === want || l === "*.Cu" || l === "F&B.Cu");
}

// ---------------------------------------------------------------- geometry helpers

function rotate([x, y]: Vec2, deg: number): Vec2 {
  // KiCad: Y down, positive angles counter-clockwise on screen.
  const a = (-deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

function circle([cx, cy]: Vec2, r: number, segs = CIRCLE_SEGS): Ring {
  const pts: Ring = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  return pts;
}

/** A stroke of width `w` from a to b with round caps (KiCad tracks). */
function stadium(a: Vec2, b: Vec2, w: number): Ring {
  const r = w / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-9) return circle(a, r);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const pts: Ring = [];
  const half = CIRCLE_SEGS / 2;
  for (let i = 0; i <= half; i++) {
    const t = ang - Math.PI / 2 - (i / half) * Math.PI;
    pts.push([a[0] + Math.cos(t) * r, a[1] + Math.sin(t) * r]);
  }
  for (let i = 0; i <= half; i++) {
    const t = ang + Math.PI / 2 - (i / half) * Math.PI;
    pts.push([b[0] + Math.cos(t) * r, b[1] + Math.sin(t) * r]);
  }
  return pts;
}

/** Rounded rectangle centred at `c`, rotated by `deg`. `r` 0 = sharp corners. */
function roundRect(c: Vec2, w: number, h: number, r: number, deg: number): Ring {
  const rr = Math.min(Math.max(r, 0), w / 2, h / 2);
  const local: Ring = [];
  if (rr < 1e-9) local.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
  else {
    const centres: Vec2[] = [[w / 2 - rr, h / 2 - rr], [-w / 2 + rr, h / 2 - rr], [-w / 2 + rr, -h / 2 + rr], [w / 2 - rr, -h / 2 + rr]];
    const per = CIRCLE_SEGS / 4;
    centres.forEach(([x, y], q) => {
      for (let i = 0; i <= per; i++) {
        const t = ((q + i / per) * Math.PI) / 2;
        local.push([x + rr * Math.cos(t), y + rr * Math.sin(t)]);
      }
    });
  }
  return local.map(p => {
    const [x, y] = rotate(p, deg);
    return [c[0] + x, c[1] + y] as Vec2;
  });
}

/** Points along a three-point arc (start, mid, end). */
export function arcPoints(start: Vec2, mid: Vec2, end: Vec2): Vec2[] {
  const [ax, ay] = start, [bx, by] = mid, [cx, cy] = end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [start, end];
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ox, ay - oy);
  const TAU = Math.PI * 2;
  const ang = (x: number, y: number) => Math.atan2(y - oy, x - ox);
  const a0 = ang(ax, ay);
  const norm = (t: number) => ((t - a0) % TAU + TAU) % TAU;
  const toMid = norm(ang(bx, by));
  const toEnd = norm(ang(cx, cy));
  const sweep = toMid <= toEnd ? toEnd : toEnd - TAU;
  const n = Math.max(4, Math.ceil(Math.abs(sweep) * r * ARC_SEGMENTS_PER_MM));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    pts.push([ox + r * Math.cos(t), oy + r * Math.sin(t)]);
  }
  return pts;
}

function polyOf(ring: Ring): Polygon {
  const closed = ring.slice();
  const first = closed[0], last = closed.at(-1);
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) closed.push([first[0], first[1]]);
  return [closed];
}

function ringArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return Math.abs(a / 2);
}

function signedRingArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return a / 2;
}

/** Area of a set of rings where holes wind opposite to their outer ring (both clipping engines output that). */
function multiArea(mp: MultiPolygon): number {
  return Math.abs(mp.reduce((sum, poly) => sum + poly.reduce((s, ring) => s + signedRingArea(ring as Vec2[]), 0), 0));
}

// polygon-clipping fails on some boards ("Unable to complete output ring", "Unable to find segment ... in
// SweepLine tree") when points nearly coincide after floating-point arithmetic (86.24 vs 86.23999999999992).
// Every operation therefore works on coordinates snapped to a grid, and the whole geometry is retried on a
// coarser grid if the library still fails. 5 µm is far below the UV spot (~20 µm), so the job is unchanged.
const SNAP_GRIDS_MM = [1e-4, 1e-3, 5e-3];

function snapRing(ring: Ring, grid: number): Ring | null {
  const out: Vec2[] = [];
  for (const [x, y] of ring) {
    const p: Vec2 = [Math.round(x / grid) * grid, Math.round(y / grid) * grid];
    const prev = out.at(-1);
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) out.pop();
  if (out.length < 3 || ringArea(out) < grid * grid) return null;
  out.push([out[0]![0], out[0]![1]]);
  return out;
}

function snapPolygon(poly: Polygon, grid: number): Polygon | null {
  const outer = poly[0] ? snapRing(poly[0] as Ring, grid) : null;
  if (!outer) return null;
  return [outer, ...poly.slice(1).map(h => snapRing(h as Ring, grid)).filter((h): h is Ring => h !== null)];
}

function snapMulti(mp: MultiPolygon, grid: number): MultiPolygon {
  return mp.map(p => snapPolygon(p, grid)).filter((p): p is Polygon => p !== null);
}

/** Boolean operations on grid-snapped input and output. */
function clipOps(grid: number) {
  const op = (fn: (a: MultiPolygon, ...b: MultiPolygon[]) => MultiPolygon) => (a: MultiPolygon, ...b: MultiPolygon[]) =>
    snapMulti(fn(snapMulti(a, grid), ...b.map(m => snapMulti(m, grid))), grid);
  return {
    union: op(polygonClipping.union),
    difference: op(polygonClipping.difference),
    intersection: op(polygonClipping.intersection),
    /** Union of many polygons, in chunks: polygon-clipping is much faster on balanced inputs than on one huge call. */
    unionAll(polys: Polygon[]): MultiPolygon {
      let layer: MultiPolygon[] = polys.map(p => snapPolygon(p, grid)).filter((p): p is Polygon => p !== null).map(p => [p]);
      if (!layer.length) return [];
      while (layer.length > 1) {
        const next: MultiPolygon[] = [];
        for (let i = 0; i < layer.length; i += 16) {
          const chunk = layer.slice(i, i + 16);
          next.push(chunk.length === 1 ? chunk[0]! : snapMulti(polygonClipping.union(chunk[0]!, ...chunk.slice(1)), grid));
        }
        layer = next;
      }
      return layer[0]!;
    },
  };
}

type ClipOps = Pick<ReturnType<typeof clipOps>, "unionAll" | "difference" | "intersection">;

/**
 * The same operations on manifold's CrossSection (Clipper2, integer coordinates): robust where
 * polygon-clipping is not. Output contours are flat (outer counter-clockwise, holes clockwise), one per
 * Polygon; every writer here handles that (even-odd fill, signed area).
 */
function manifoldOps(k: ManifoldToplevel): ClipOps & { dispose(): void } {
  const owned: Array<{ delete(): void }> = [];
  const keep = <T extends { delete(): void }>(x: T): T => { owned.push(x); return x; };
  const contours = (mp: MultiPolygon) => mp.flatMap(p => p.map(ring => (ring as Vec2[]).map(([x, y]) => [x, y] as [number, number])));
  // manifold reads a list whose first ring has < 3 points as one ring, and fails on an empty list:
  // drop degenerate rings and give it a zero-area triangle (= empty) when nothing is left.
  const make = (rings: Array<Array<[number, number]>>, rule: "EvenOdd" | "Positive") => {
    const valid = rings.filter(r => r.length >= 3);
    return keep(new k.CrossSection(valid.length ? valid : [[[0, 0], [0, 0], [0, 0]]], rule));
  };
  const cs = (mp: MultiPolygon) => make(contours(mp), "EvenOdd");
  const out = (c: InstanceType<ManifoldToplevel["CrossSection"]>): MultiPolygon => c.toPolygons().map(ring => [ring.map(([x, y]) => [x, y] as [number, number])]);
  // Union of many polygons in one constructor call: outer rings counter-clockwise, holes clockwise, then the
  // Positive fill rule keeps every point covered by at least one polygon.
  const unionCs = (list: MultiPolygon[]) => make(list.flatMap(mp => mp.flatMap(p => p.map((ring, i) => {
    const pts = (ring as Vec2[]).map(([x, y]) => [x, y] as [number, number]);
    // signedRingArea is negative for counter-clockwise rings (y up).
    return (signedRingArea(pts) < 0) === (i === 0) ? pts : pts.reverse();
  }))), "Positive");
  return {
    unionAll: polys => (polys.length ? out(unionCs(polys.map(p => [p]))) : []),
    // One operand is already a clean set of contours (holes wound backwards): read it even-odd. Several
    // operands are raw shapes that may overlap: union them.
    difference: (a, ...b) => (b.length ? out(keep(cs(a).subtract(b.length === 1 ? cs(b[0]!) : unionCs(b)))) : a),
    intersection: (a, ...b) => out(b.reduce((acc, m) => keep(acc.intersect(cs(m))), cs(a))),
    dispose: () => { for (const x of owned.splice(0)) x.delete(); },
  };
}

/** Runs the geometry on the finest grid that polygon-clipping can handle. */
function withSnapGrid<T>(compute: (ops: ClipOps) => T): T {
  let last: unknown;
  for (const grid of SNAP_GRIDS_MM) {
    try {
      return compute(clipOps(grid));
    } catch (error) {
      last = error;
    }
  }
  throw new CopperLaserOptionsError(`could not work out the copper shapes on this board (${last instanceof Error ? last.message : String(last)}); check the board for overlapping or broken copper`);
}

// ---------------------------------------------------------------- board → copper primitives

type CopperShape = { ring: Ring; grow: (by: number) => Ring[] };

function collect(text: string, side: CopperSide) {
  const root = parseSexpr(text).find((n): n is Sexpr[] => head(n) === "kicad_pcb");
  if (!root) throw new CopperLaserOptionsError("not a KiCad board file");
  const shapes: CopperShape[] = [];
  const outline: Vec2[] = [];
  const drills: CopperLaserBuild["drills"] = [];
  const counts = { tracks: 0, arcs: 0, vias: 0, pads: 0, zones: 0, graphics: 0 };
  const warnings: string[] = [];

  const strokeShape = (pts: Vec2[], width: number): CopperShape[] =>
    pts.slice(1).map((b, i) => ({ ring: stadium(pts[i]!, b, width), grow: by => [stadium(pts[i]!, b, width + 2 * by)] }));
  const polygonShape = (ring: Ring, strokeWidth = 0): CopperShape[] => {
    const out: CopperShape[] = [{
      ring,
      grow: by => [ring, ...ring.map((p, i) => stadium(p, ring[(i + 1) % ring.length]!, 2 * by))],
    }];
    if (strokeWidth > 0) out.push(...strokeShape([...ring, ring[0]!], strokeWidth));
    return out;
  };

  const graphic = (n: Sexpr[], origin: Vec2, angle: number, layers: string[]) => {
    const kind = head(n)!.replace(/^(gr|fp)_/, "");
    const tf = (p: Vec2): Vec2 => {
      const [x, y] = rotate(p, angle);
      return [origin[0] + x, origin[1] + y];
    };
    const width = num(kid(n, "width")?.[1], num(kid(kid(n, "stroke") ?? [], "width")?.[1], 0.1));
    const fillNode = kid(n, "fill");
    const filled = !!fillNode && (fillNode[1] === "yes" || fillNode[1] === "solid" || kid(fillNode, "type")?.[1] === "solid");
    const start = point(kid(n, "start")), end = point(kid(n, "end"));
    if (layers.includes("Edge.Cuts")) {
      if (kind === "line" && start && end) outline.push(tf(start), tf(end));
      else if (kind === "rect" && start && end) outline.push(tf(start), tf(end), tf([start[0], end[1]]), tf([end[0], start[1]]));
      else if (kind === "arc" && start && end && kid(n, "mid")) outline.push(...arcPoints(tf(start), tf(point(kid(n, "mid"))!), tf(end)));
      else if (kind === "circle") {
        const c = point(kid(n, "center")), e = end;
        if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); outline.push(tf([c[0] - r, c[1] - r]), tf([c[0] + r, c[1] + r])); }
      } else if (kind === "poly") outline.push(...kids(kid(n, "pts") ?? [], "xy").map(xy => tf(point(xy)!)));
      return;
    }
    if (!onCopper(layers, side)) return;
    counts.graphics++;
    if (kind === "line" && start && end) shapes.push(...strokeShape([tf(start), tf(end)], width));
    else if (kind === "arc" && start && end && kid(n, "mid")) shapes.push(...strokeShape(arcPoints(tf(start), tf(point(kid(n, "mid"))!), tf(end)), width));
    else if (kind === "rect" && start && end) {
      const ring = [start, [end[0], start[1]], end, [start[0], end[1]]].map(p => tf(p as Vec2));
      shapes.push(...(filled ? polygonShape(ring, width) : strokeShape([...ring, ring[0]!], width)));
    } else if (kind === "circle") {
      const c = point(kid(n, "center"));
      if (c && end) {
        const r = Math.hypot(end[0] - c[0], end[1] - c[1]);
        const ring = circle(tf(c), r);
        shapes.push(...(filled ? polygonShape(ring, width) : strokeShape([...ring, ring[0]!], width)));
      }
    } else if (kind === "poly") {
      const ring = kids(kid(n, "pts") ?? [], "xy").map(xy => tf(point(xy)!));
      if (ring.length >= 3) shapes.push(...(filled || head(n) === "gr_poly" ? polygonShape(ring, width) : strokeShape(ring, width)));
    } else warnings.push(`copper ${head(n)} is not supported and was left out`);
  };

  for (const n of root) {
    if (!Array.isArray(n)) continue;
    const h = head(n);
    if (h === "segment" && onCopper(layersOf(n), side)) {
      const a = point(kid(n, "start")), b = point(kid(n, "end"));
      if (a && b) { counts.tracks++; shapes.push(...strokeShape([a, b], num(kid(n, "width")?.[1], 0.25))); }
    } else if (h === "arc" && onCopper(layersOf(n), side)) {
      const a = point(kid(n, "start")), m = point(kid(n, "mid")), b = point(kid(n, "end"));
      if (a && m && b) { counts.arcs++; shapes.push(...strokeShape(arcPoints(a, m, b), num(kid(n, "width")?.[1], 0.25))); }
    } else if (h === "via") {
      const layers = layersOf(n);
      const at = point(kid(n, "at"));
      const size = num(kid(n, "size")?.[1], 0.6);
      // Through vias list only their end layers; blind/buried ones are not on a single-sided blank.
      if (at && (onCopper(layers, side) || layers.length === 0)) {
        counts.vias++;
        shapes.push({ ring: circle(at, size / 2), grow: by => [circle(at, size / 2 + by)] });
        drills.push({ x: at[0], y: at[1], diameterMm: num(kid(n, "drill")?.[1], 0.3), kind: "via" });
      }
    } else if (h === "zone") {
      for (const fp of kids(n, "filled_polygon")) {
        const layer = kid(fp, "layer")?.[1];
        if (typeof layer !== "string" || !onCopper([layer], side)) continue;
        const ring = kids(kid(fp, "pts") ?? [], "xy").map(xy => point(xy)!);
        if (ring.length >= 3) { counts.zones++; shapes.push(...polygonShape(ring)); }
      }
    } else if (h && /^gr_(line|arc|rect|circle|poly)$/.test(h)) graphic(n, [0, 0], 0, layersOf(n));
    else if (h === "footprint" || h === "module") {
      const at = kid(n, "at");
      const origin: Vec2 = [num(at?.[1]), num(at?.[2])];
      const fpAngle = num(at?.[3]);
      for (const c of n) {
        if (!Array.isArray(c)) continue;
        const ch = head(c);
        if (ch && /^fp_(line|arc|rect|circle|poly)$/.test(ch)) graphic(c, origin, fpAngle, layersOf(c));
        if (ch !== "pad") continue;
        const layers = layersOf(c);
        const type = c[2];
        const shape = c[3];
        const padAt = kid(c, "at");
        const local: Vec2 = [num(padAt?.[1]), num(padAt?.[2])];
        const [rx, ry] = rotate(local, fpAngle);
        const centre: Vec2 = [origin[0] + rx, origin[1] + ry];
        const angle = num(padAt?.[3]);
        const size = kid(c, "size");
        const w = num(size?.[1]), hgt = num(size?.[2], w);
        const drill = kid(c, "drill");
        if (drill && (type === "thru_hole" || type === "np_thru_hole")) {
          const d = drill[1] === "oval" ? Math.min(num(drill[2]), num(drill[3], num(drill[2]))) : num(drill[1]);
          if (d > 0) drills.push({ x: centre[0], y: centre[1], diameterMm: d, kind: "pad" });
        }
        if (!onCopper(layers, side) || type === "np_thru_hole" || w <= 0) continue;
        counts.pads++;
        let radius = 0;
        if (shape === "circle") radius = Math.min(w, hgt) / 2;
        else if (shape === "oval") radius = Math.min(w, hgt) / 2;
        else if (shape === "roundrect") radius = Math.min(w, hgt) * num(kid(c, "roundrect_rratio")?.[1], 0.25);
        else if (shape !== "rect") warnings.push(`pad ${String(c[1])} is ${String(shape)}; using its bounding rectangle`);
        const ww = shape === "circle" ? Math.min(w, hgt) : w, hh = shape === "circle" ? Math.min(w, hgt) : hgt;
        shapes.push({ ring: roundRect(centre, ww, hh, radius, angle), grow: by => [roundRect(centre, ww + 2 * by, hh + 2 * by, radius + by, angle)] });
      }
    }
  }
  return { shapes, outline, drills, counts, warnings };
}

// ---------------------------------------------------------------- build

const clampSetting = (s: CopperPassSettings): CopperPassSettings => {
  const check = (name: string, v: number, min: number, max: number) => {
    if (!Number.isFinite(v) || v < min || v > max) throw new CopperLaserOptionsError(`${name} must be between ${min} and ${max}`);
  };
  check("power", s.powerPct, 0, 100);
  check("speed", s.speedMmPerS, 1, 20000);
  check("frequency", s.frequencyKhz, 1, 4000);
  check("passes", s.passes, 0, 100);
  check("interval", s.intervalMm, 0, 1);
  return { ...s, passes: Math.round(s.passes) };
};

export function resolveCopperSettings(preset: CopperPresetId, opts: CopperLaserOptions["settings"] = {}): CopperJobSettings {
  const base = COPPER_PRESETS[preset];
  if (!base) throw new CopperLaserOptionsError(`unknown preset ${preset}; use ${COPPER_PRESET_IDS.join(" or ")}`);
  return {
    ablate: clampSetting({ ...base.ablate, ...opts.ablate }),
    edge: clampSetting({ ...base.edge, ...opts.edge }),
    clean: clampSetting({ ...base.clean, ...opts.clean }),
    lensMm: base.lensMm,
  };
}

/** The 70 mm lens when the board fits its field with a margin, else the 150 mm lens. */
export function suggestCopperPreset(widthMm: number, heightMm: number): CopperPresetId {
  return Math.max(widthMm, heightMm) <= COPPER_PRESETS["omni-x-6w-70mm"].fieldMm - 5 ? "omni-x-6w-70mm" : "omni-x-6w-150mm";
}

/**
 * Builds the copper-removal geometry. With `kernel` (manifold, see {@link solidKernel}) the boolean operations
 * run on Clipper2, which handles every board; without it they run on polygon-clipping with grid snapping.
 */
export function buildCopperLaserJob(pcbText: string, opts: CopperLaserOptions = {}, kernel?: ManifoldToplevel): CopperLaserBuild {
  const side = opts.side ?? "F";
  const mode = opts.mode ?? "isolation";
  const isolationMm = opts.isolationMm ?? 0.4;
  const mirror = opts.mirror ?? side === "B";
  const drillMarkMm = opts.drillMarkMm ?? 0.4;
  const edgeMarginMm = opts.edgeMarginMm ?? 0;
  if (!(isolationMm > 0.05 && isolationMm <= 5)) throw new CopperLaserOptionsError("isolationMm must be between 0.05 and 5 mm");
  if (!(drillMarkMm >= 0 && drillMarkMm <= 2)) throw new CopperLaserOptionsError("drillMarkMm must be between 0 and 2 mm");
  const { shapes, outline, drills, counts, warnings } = collect(pcbText, side);
  if (!outline.length) throw new CopperLaserOptionsError("the board has no Edge.Cuts outline; draw the outline so the job knows the blank size");
  if (!shapes.length) throw new CopperLaserOptionsError(`there is no copper on ${side}.Cu to isolate`);

  const minX = Math.min(...outline.map(p => p[0])), maxX = Math.max(...outline.map(p => p[0]));
  const minY = Math.min(...outline.map(p => p[1])), maxY = Math.max(...outline.map(p => p[1]));
  const board = { minX, minY, maxX, maxY, widthMm: maxX - minX, heightMm: maxY - minY };
  const preset = opts.preset ?? suggestCopperPreset(board.widthMm, board.heightMm);
  const settings = resolveCopperSettings(preset, opts.settings);
  const field = COPPER_PRESETS[preset].fieldMm;
  if (Math.max(board.widthMm, board.heightMm) > field - 2) warnings.push(`the board (${board.widthMm.toFixed(1)} × ${board.heightMm.toFixed(1)} mm) does not fit the ${field} mm lens field`);

  // Board (mm, Y down) → job (origin at the board's bottom-left corner, Y up, optionally mirrored).
  const toJob = ([x, y]: Vec2): Vec2 => [mirror ? maxX - x : x - minX, maxY - y];
  const mapPoly = (p: Polygon): Polygon => p.map(ring => ring.map(pt => toJob(pt as Vec2)));

  const pocket = drillMarkMm > 0 ? drills.filter(d => d.kind === "pad").map(d => polyOf(circle([d.x, d.y], Math.min(drillMarkMm, d.diameterMm) / 2, 16))) : [];
  const inset = edgeMarginMm;
  const boardPoly: Polygon = polyOf([[minX + inset, minY + inset], [maxX - inset, minY + inset], [maxX - inset, maxY - inset], [minX + inset, maxY - inset]]);
  const geometry = (ops: ClipOps) => {
    let copper = ops.unionAll(shapes.map(s => polyOf(s.ring)));
    if (pocket.length) copper = ops.difference(copper, ...pocket.map(p => [p] as MultiPolygon));
    copper = ops.intersection(copper, [boardPoly]);
    const region = mode === "full" ? [boardPoly] : ops.intersection(ops.unionAll(shapes.flatMap(s => s.grow(isolationMm)).map(polyOf)), [boardPoly]);
    return { copper, ablate: ops.difference(region, copper) };
  };
  let result: { copper: MultiPolygon; ablate: MultiPolygon };
  if (kernel) {
    const ops = manifoldOps(kernel);
    try { result = geometry(ops); } finally { ops.dispose(); }
  } else result = withSnapGrid(geometry);
  const { copper, ablate } = result;

  if (counts.pads === 0 && counts.tracks === 0) warnings.push("no pads or tracks on this side; check that the right copper side was chosen");
  if (!mirror && side === "B") warnings.push("bottom copper is not mirrored; mirror it if the blank is lasered from the back");

  return {
    side,
    mode,
    mirror,
    isolationMm,
    preset,
    board,
    copper: copper.map(mapPoly),
    ablate: ablate.map(mapPoly),
    drills: drills.map(d => { const [x, y] = toJob([d.x, d.y]); return { ...d, x, y }; }),
    counts,
    areaMm2: { board: board.widthMm * board.heightMm, copper: multiArea(copper), ablate: multiArea(ablate) },
    settings,
    warnings,
  };
}

// ---------------------------------------------------------------- writers

const fmt = (n: number) => n.toFixed(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough marking time: hatch length / speed per pass, plus edge length / speed per pass. */
export function estimateCopperJobSeconds(build: CopperLaserBuild): number {
  const s = build.settings;
  const perimeter = (mp: MultiPolygon) => mp.reduce((sum, poly) => sum + poly.reduce((ps, ring) => ps + ring.slice(1).reduce((rs, p, i) => rs + Math.hypot(p[0] - ring[i]![0], p[1] - ring[i]![1]), 0), 0), 0);
  const fill = (p: CopperPassSettings) => (p.passes && p.intervalMm ? (build.areaMm2.ablate / p.intervalMm / p.speedMmPerS) * p.passes : 0);
  const edges = (s.edge.passes * perimeter(build.copper)) / s.edge.speedMmPerS;
  // Galvo jump and laser on/off delays add roughly 25 % on fills made of many short lines.
  return Math.round((fill(s.ablate) + fill(s.clean)) * 1.25 + edges);
}

function svgPath(mp: MultiPolygon): string {
  return mp.map(poly => poly.map(ring => `M${ring.map(p => `${fmt(p[0])} ${fmt(p[1])}`).join("L")}Z`).join("")).join("");
}

/** Filled SVG in millimetres. Red = copper to remove (even-odd fill), blue = copper edges, grey = board outline (do not cut). */
export function copperLaserSvg(build: CopperLaserBuild): string {
  const { widthMm: w, heightMm: h } = build.board;
  // SVG is Y down; flip the job's Y-up geometry back.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">
  <title>${esc(`${build.side}.Cu copper removal (${build.mode}${build.mirror ? ", mirrored" : ""})`)}</title>
  <g transform="matrix(1 0 0 -1 0 ${fmt(h)})">
    <path id="ABLATE" d="${svgPath(build.ablate)}" fill="#ff0000" fill-rule="evenodd" stroke="none"/>
    <path id="EDGE" d="${svgPath(build.copper)}" fill="none" stroke="#0000ff" stroke-width="0.02"/>
    <rect id="BOARD" x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" fill="none" stroke="#808080" stroke-width="0.05"/>
  </g>
</svg>
`;
}

/** Bounds of the copper to remove, in job coordinates (mm, origin bottom-left, Y up). */
export function ablateBounds(build: CopperLaserBuild): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of build.ablate) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/**
 * SVG for ComMarker Studio: only the copper to remove, cropped to its own bounds. Studio scales every
 * imported vector to its lens field and marks every outline, so the board outline and the edge pass are
 * left out, and fabPlane sets the size and position in Studio from {@link ablateBounds} after importing.
 */
export function copperLaserStudioSvg(build: CopperLaserBuild): string {
  const b = ablateBounds(build) ?? { x: 0, y: 0, width: build.board.widthMm, height: build.board.heightMm };
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(b.width)}mm" height="${fmt(b.height)}mm" viewBox="${fmt(b.x)} 0 ${fmt(b.width)} ${fmt(b.height)}">
  <g transform="matrix(1 0 0 -1 0 ${fmt(b.y + b.height)})">
    <path id="ABLATE" d="${svgPath(build.ablate)}" fill="#000000" fill-rule="evenodd" stroke="none"/>
  </g>
</svg>
`;
}

function lbrnShape(cutIndex: number, ring: Vec2[]): string {
  const pts = ring.length > 1 && ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return "";
  const verts = pts.map(([x, y]) => `V${fmt(x)} ${fmt(y)}`).join("");
  const prims = pts.map((_, i) => `L${i} ${(i + 1) % pts.length}`).join("");
  return `  <Shape Type="Path" CutIndex="${cutIndex}">
    <XForm>1 0 0 1 0 0</XForm>
    <VertList>${verts}</VertList>
    <PrimList>${prims}</PrimList>
  </Shape>`;
}

function lbrnCut(index: number, name: string, type: "Scan" | "Cut", p: CopperPassSettings, output: boolean, priority: number): string {
  const fields: Array<[string, string | number]> = [
    ["index", index],
    ["name", name],
    ["minPower", p.powerPct],
    ["maxPower", p.powerPct],
    ["speed", p.speedMmPerS],
    ["frequency", Math.round(p.frequencyKhz * 1000)],
    ["overrideFrequency", 1],
    ["QPulseWidth", p.pulseNs],
    ["doOutput", output && p.passes > 0 ? 1 : 0],
    ["numPasses", Math.max(1, p.passes)],
    ["priority", priority],
    ["bidir", 1],
    ["crossHatch", type === "Scan" && p.angleStepDeg === 90 ? 1 : 0],
    ["interval", p.intervalMm || 0.03],
    ["angle", p.angleDeg],
    ["angleIncrement", p.angleStepDeg === 90 ? 0 : p.angleStepDeg],
    ["scanOpt", "individual"],
    ["kerf", 0],
    ["zOffset", 0],
  ];
  return `  <CutSetting type="${type}">
${fields.map(([k, v]) => `    <${k} Value="${esc(String(v))}"/>`).join("\n")}
  </CutSetting>`;
}

/**
 * LightBurn galvo project: C00 ABLATE (fill), C01 EDGE (line), C02 CLEAN (fill, off when 0 passes),
 * C03 BOARD (outline, output off). Origin is the board's bottom-left corner.
 */
export function copperLaserLbrn2(build: CopperLaserBuild): string {
  const s = build.settings;
  const shapes: string[] = [];
  for (const poly of build.ablate) for (const ring of poly) shapes.push(lbrnShape(0, ring as Vec2[]), lbrnShape(2, ring as Vec2[]));
  for (const poly of build.copper) for (const ring of poly) shapes.push(lbrnShape(1, ring as Vec2[]));
  const { widthMm: w, heightMm: h } = build.board;
  shapes.push(lbrnShape(3, [[0, 0], [w, 0], [w, h], [0, h]]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<LightBurnProject AppVersion="1.7.04" FormatVersion="1" MaterialHeight="1.6" MirrorX="False" MirrorY="False">
${lbrnCut(0, "ABLATE", "Scan", s.ablate, true, 0)}
${lbrnCut(1, "EDGE", "Cut", s.edge, true, 1)}
${lbrnCut(2, "CLEAN", "Scan", s.clean, true, 2)}
${lbrnCut(3, "BOARD", "Cut", s.edge, false, 3)}
<!-- ${esc(`${build.side}.Cu ${build.mode} copper removal, ${fmt(w)} x ${fmt(h)} mm. Starting-point settings for a ComMarker Omni X 6 W UV; run a coupon first.`)} -->
${shapes.filter(Boolean).join("\n")}
</LightBurnProject>
`;
}

export type CopperLaserSummary = {
  preset: CopperPresetId;
  side: CopperSide;
  mode: CopperMode;
  mirror: boolean;
  boardMm: { width: number; height: number };
  areaMm2: CopperLaserBuild["areaMm2"];
  counts: CopperLaserBuild["counts"];
  drills: number;
  estimatedSeconds: number;
  settings: CopperJobSettings;
  warnings: string[];
  files: { lbrn2: string; svg: string; json: string; studioSvg: string };
  /** Size and offset of the Studio SVG's shape within the board (mm, origin bottom-left, Y up). */
  studio: { x: number; y: number; width: number; height: number } | null;
};

export async function exportCopperLaserJob(opts: CopperLaserOptions & { board: string; outDir: string }): Promise<CopperLaserSummary> {
  const built = buildCopperLaserJob(await Bun.file(opts.board).text(), opts, await solidKernel());
  await mkdir(opts.outDir, { recursive: true });
  const stem = `${built.side}-Cu-laser-${built.mode}`;
  const files = { lbrn2: join(opts.outDir, `${stem}.lbrn2`), svg: join(opts.outDir, `${stem}.svg`), json: join(opts.outDir, `${stem}.json`), studioSvg: join(opts.outDir, `${stem}.studio.svg`) };
  const bounds = ablateBounds(built);
  const summary: CopperLaserSummary = {
    preset: built.preset,
    side: built.side,
    mode: built.mode,
    mirror: built.mirror,
    boardMm: { width: +built.board.widthMm.toFixed(3), height: +built.board.heightMm.toFixed(3) },
    areaMm2: { board: +built.areaMm2.board.toFixed(1), copper: +built.areaMm2.copper.toFixed(1), ablate: +built.areaMm2.ablate.toFixed(1) },
    counts: built.counts,
    drills: built.drills.length,
    estimatedSeconds: estimateCopperJobSeconds(built),
    settings: built.settings,
    warnings: built.warnings,
    files,
    studio: bounds && { x: +bounds.x.toFixed(4), y: +bounds.y.toFixed(4), width: +bounds.width.toFixed(4), height: +bounds.height.toFixed(4) },
  };
  await writeFile(files.lbrn2, copperLaserLbrn2(built));
  await writeFile(files.svg, copperLaserSvg(built));
  await writeFile(files.studioSvg, copperLaserStudioSvg(built));
  await writeFile(files.json, JSON.stringify({ ...summary, drillsMm: built.drills }, null, 2));
  return summary;
}
