/**
 * Shared pieces of the art importers: 2D affine matrices, curve flattening to a chord tolerance, the fill
 * resolution on manifold's CrossSection (Clipper2) and the final move to the origin.
 *
 * Every curve is flattened in final millimetres (control points are transformed first, or the sample count
 * comes from the transform's largest stretch), so the chord error bound holds whatever the file's scale.
 */
import Module, { type ManifoldToplevel } from "manifold-3d";
// @ts-expect-error Bun embeds this asset in the compiled app (as packages/kicad/src/enclosure-solid.ts does).
import wasmPath from "manifold-3d/manifold.wasm" with { type: "file" };
import type { ArtGeometry, Vec } from "./index";

/** A file that cannot be read as the format it claims to be. */
export class ArtImportError extends Error {
  override name = "ArtImportError";
}

export const DEFAULT_TOLERANCE_MM = 0.01;

export function toleranceOf(opts: { toleranceMm?: number } | undefined): number {
  const t = opts?.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  if (!(Number.isFinite(t) && t > 0)) throw new RangeError(`toleranceMm must be a positive number of millimetres (got ${t})`);
  return t;
}

// ---------------------------------------------------------------- affine matrices

/** 2D affine matrix in SVG order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m·n: applies n first, then m (an SVG transform list "m n" is m·n). */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const apply = (m: Mat, [x, y]: Vec): Vec => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];

export function rotate(deg: number): Mat {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
}

/** The largest factor by which the matrix stretches a length (its largest singular value). */
export function maxScale(m: Mat): number {
  const [a, b, c, d] = m;
  const sum = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  return Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
}

// ---------------------------------------------------------------- flattening

const MAX_POINTS = 5_000_000;

/** Caps the points one file can produce, so an absurd file fails cleanly instead of exhausting memory. */
export class PointBudget {
  private left = MAX_POINTS;
  take(n: number) {
    this.left -= n;
    if (!(this.left >= 0)) {
      throw new ArtImportError("the drawing is too detailed: it would need more than 5 million points (try a larger tolerance)");
    }
  }
}

/**
 * Caps work that makes no points (elements visited, copies placed, rules checked), so a small hostile file
 * cannot keep the core busy: every importer runs on its event loop.
 */
export class WorkBudget {
  private left: number;
  constructor(limit: number, private readonly what: string) {
    this.left = limit;
  }
  take(n = 1) {
    this.left -= n;
    if (!(this.left >= 0)) throw new ArtImportError(`the drawing is too complex: ${this.what}`);
  }
}

/**
 * Chords needed so a curve whose second derivative stays below `d2` (over a parameter range of 1) is within
 * `tol` of them: linear interpolation over a step h is off by at most h²/8 · max|C''|.
 */
export const chordsFor = (d2: number, tol: number) => Math.max(1, Math.ceil(Math.sqrt(d2 / (8 * tol))));

/** Appends a cubic Bézier (in final mm) after p0, which is already in `out`. */
export function flattenCubic(out: Vec[], p0: Vec, p1: Vec, p2: Vec, p3: Vec, tol: number, budget: PointBudget) {
  // B'' is linear in t, so |B''| peaks at an end: 6·max(|p0 − 2p1 + p2|, |p1 − 2p2 + p3|).
  const d2 = 6 * Math.max(
    Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
    Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]),
  );
  const n = chordsFor(d2, tol);
  budget.take(n);
  for (let i = 1; i < n; i++) {
    const t = i / n, s = 1 - t;
    const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  out.push([p3[0], p3[1]]);
}

/** Appends a quadratic Bézier (in final mm) after p0, which is already in `out`. */
export function flattenQuad(out: Vec[], p0: Vec, p1: Vec, p2: Vec, tol: number, budget: PointBudget) {
  // B'' = 2(p0 − 2p1 + p2) everywhere.
  const n = chordsFor(2 * Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]), tol);
  budget.take(n);
  for (let i = 1; i < n; i++) {
    const t = i / n, s = 1 - t;
    out.push([s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0], s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1]]);
  }
  out.push([p2[0], p2[1]]);
}

/**
 * Steps for an arc of `sweep` radians on an ellipse whose largest radius (in final mm) is `radius`. A chord
 * spanning dθ sits r·(1 − cos(dθ/2)) inside a circle; an affine map stretches that by at most its largest
 * scale, which `radius` already includes. Never more than 90° per step, even for tiny arcs.
 */
export function arcSteps(radius: number, sweep: number, tol: number): number {
  const step = tol >= radius ? Math.PI / 2 : Math.min(Math.PI / 2, 2 * Math.acos(1 - tol / radius));
  return Math.max(1, Math.ceil(Math.abs(sweep) / step));
}

// ---------------------------------------------------------------- fills

/** Rings to fill with one rule; groups are unioned with each other. */
export type FillGroup = { rings: Vec[][]; rule: "NonZero" | "EvenOdd" };

let kernelReady: Promise<ManifoldToplevel> | undefined;
function kernel() {
  kernelReady ??= Bun.file(wasmPath)
    .arrayBuffer()
    .then(async (wasmBinary) => {
      // Emscripten accepts wasmBinary; the package's declaration only lists locateFile.
      const m = await Module({ wasmBinary, locateFile: () => wasmPath } as Parameters<typeof Module>[0]);
      m.setup();
      return m;
    })
    .catch((error) => {
      kernelReady = undefined;
      throw error;
    });
  return kernelReady;
}

/**
 * Applies each group's fill rule and unions the groups, on manifold's CrossSection. The output contours do
 * not overlap (outer boundaries counter-clockwise, holes clockwise), so the even-odd rule reads them right
 * whatever their orientation.
 */
async function resolveFills(groups: FillGroup[]): Promise<Vec[][]> {
  // manifold fails on an empty list and reads a list whose first ring has < 3 points as a single ring.
  const usable = groups.map(g => ({ rule: g.rule, rings: g.rings.filter(r => r.length >= 3) })).filter(g => g.rings.length);
  if (!usable.length) return [];
  const k = await kernel();
  const owned: Array<{ delete(): void }> = [];
  const keep = <T extends { delete(): void }>(x: T): T => { owned.push(x); return x; };
  try {
    const parts = usable.map(g => keep(new k.CrossSection(g.rings, g.rule)));
    const all = parts.length === 1 ? parts[0]! : keep(k.CrossSection.union(parts));
    return all.toPolygons().map(ring => ring.map(([x, y]) => [x, y] as Vec));
  } catch (error) {
    // Clipper2 throws a bare number (an exception pointer) for coordinates beyond about 1e10.
    if (typeof error === "number") throw new ArtImportError("the drawing is too large to fill (more than 10,000 km across); check its units");
    throw error;
  } finally {
    for (const x of owned) x.delete();
  }
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function bounds(sets: Vec[][][]): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const set of sets) for (const ring of set) for (const [x, y] of ring) {
    if (!(Number.isFinite(x) && Number.isFinite(y))) throw new ArtImportError("the drawing has coordinates that are not finite numbers");
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

const shift = (rings: Vec[][], dx: number, dy: number) => rings.map(r => r.map(([x, y]) => [x - dx, y - dy] as Vec));

/**
 * Resolves the fills and moves everything so the bounding box starts at (0, 0). `warnings` gains a generic
 * note when nothing is left to mark and no other warning explains why.
 */
export async function finish(groups: FillGroup[], lines: Vec[][], warnings: string[]): Promise<ArtGeometry> {
  const empty = (): ArtGeometry => {
    if (!warnings.length) warnings.push("The file has no shapes that can be marked.");
    return { fills: [], lines: [], widthMm: 0, heightMm: 0, warnings };
  };
  const lineList = lines.filter(l => l.length >= 2);
  const pre = bounds([...groups.map(g => g.rings), lineList]);
  if (!pre) return empty();
  // Near the origin first: Clipper2 works on scaled integers, so far-away coordinates (a DXF in survey
  // coordinates, say) would lose precision or overflow.
  const fills = await resolveFills(groups.map(g => ({ rule: g.rule, rings: shift(g.rings, pre.minX, pre.minY) })));
  const near = shift(lineList, pre.minX, pre.minY);
  const box = bounds([fills, near]);
  if (!box) return empty();
  return {
    fills: shift(fills, box.minX, box.minY),
    lines: shift(near, box.minX, box.minY),
    widthMm: box.maxX - box.minX,
    heightMm: box.maxY - box.minY,
    warnings,
  };
}

/** "1 text element was" / "3 text elements were". */
export const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? `${noun} was` : `${plural} were`}`;
