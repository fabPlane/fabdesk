import type { Point, Rect } from "./types";

export const emptyRect = (): Rect => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
});

export function expand(r: Rect, x: number, y: number): void {
  if (x < r.minX) r.minX = x;
  if (y < r.minY) r.minY = y;
  if (x > r.maxX) r.maxX = x;
  if (y > r.maxY) r.maxY = y;
}

export function validRect(r: Rect): boolean {
  return Number.isFinite(r.minX) && Number.isFinite(r.minY) && r.maxX > r.minX && r.maxY > r.minY;
}

export function padRect(r: Rect, pad: number): Rect {
  return { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
}

export function rectSize(r: Rect): { widthMm: number; heightMm: number } {
  return { widthMm: r.maxX - r.minX, heightMm: r.maxY - r.minY };
}

export function almostEqual(a: number, b: number, tol = 0.05): boolean {
  return Math.abs(a - b) <= tol;
}

export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const intersect =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 1e-15) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export type Segment = { x1: number; y1: number; x2: number; y2: number };

const KEY = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`;

/** Chain draw segments into polylines; a contour is closed when start meets end. */
export function chainContours(segments: readonly Segment[], tol = 0.02): Array<{
  points: Point[];
  closed: boolean;
}> {
  const unused = segments.map((s) => ({ ...s, used: false }));
  const contours: Array<{ points: Point[]; closed: boolean }> = [];
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

  for (let i = 0; i < unused.length; i++) {
    const start = unused[i];
    if (!start || start.used) continue;
    start.used = true;
    const points: Point[] = [
      { x: start.x1, y: start.y1 },
      { x: start.x2, y: start.y2 },
    ];
    let grew = true;
    while (grew) {
      grew = false;
      const head = points[0]!;
      const tail = points[points.length - 1]!;
      for (const seg of unused) {
        if (seg.used) continue;
        const a = { x: seg.x1, y: seg.y1 };
        const b = { x: seg.x2, y: seg.y2 };
        if (near(tail, a)) {
          points.push(b);
          seg.used = true;
          grew = true;
          break;
        }
        if (near(tail, b)) {
          points.push(a);
          seg.used = true;
          grew = true;
          break;
        }
        if (near(head, a)) {
          points.unshift(b);
          seg.used = true;
          grew = true;
          break;
        }
        if (near(head, b)) {
          points.unshift(a);
          seg.used = true;
          grew = true;
          break;
        }
      }
    }
    const closed = points.length > 2 && near(points[0]!, points[points.length - 1]!);
    if (closed) points.pop();
    contours.push({ points, closed });
  }
  void KEY;
  return contours;
}

export function boundsOfPoints(points: readonly Point[]): Rect {
  const r = emptyRect();
  for (const p of points) expand(r, p.x, p.y);
  return r;
}

export function normalizeDeg(deg: number): number {
  let n = deg % 360;
  if (n < 0) n += 360;
  return n;
}

export function rotationDelta(a: number, b: number): number {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return Math.min(d, 360 - d);
}
