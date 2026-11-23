/** Pure geometry for the silkscreen checks: boxes and polygons in mm. */

export type Pt = [number, number];
export type Rect = [number, number, number, number];
export type Poly = Pt[];

export function inside(x: number, y: number, poly: Poly): boolean {
  let c = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) c = !c;
  }
  return c;
}

/** Liang-Barsky clip: segment a-b touches rect r. */
export function segRect(a: Pt, b: Pt, r: Rect): boolean {
  const [x0, y0, x1, y1] = r;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        t0 = Math.max(t0, t);
      } else {
        if (t < t0) return false;
        t1 = Math.min(t1, t);
      }
    }
  }
  return t0 <= t1;
}

/** Axis-aligned rect r intersects polygon `poly` (bounding box `bb`). */
export function rectPolyHit(r: Rect, poly: Poly, bb: Rect): boolean {
  if (r[2] < bb[0] || r[0] > bb[2] || r[3] < bb[1] || r[1] > bb[3]) return false;
  const [x0, y0, x1, y1] = r;
  for (const [x, y] of poly) if (x0 <= x && x <= x1 && y0 <= y && y <= y1) return true;
  if (inside((x0 + x1) / 2, (y0 + y1) / 2, poly)) return true;
  const n = poly.length;
  for (let i = 0; i < n; i++) if (segRect(poly[i]!, poly[(i + 1) % n]!, r)) return true;
  return false;
}

export const grow = (r: Rect, c: number): Rect => [r[0] - c, r[1] - c, r[2] + c, r[3] + c];

export function rectDist(r: Rect, b: Rect): number {
  const dx = Math.max(b[0] - r[2], r[0] - b[2], 0);
  const dy = Math.max(b[1] - r[3], r[1] - b[3], 0);
  return Math.hypot(dx, dy);
}

export const overlap = (a: Rect, b: Rect) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

export const bboxOf = (poly: Poly): Rect => [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))];

export type GridItem<K extends string = string> = { kind: K; owner: unknown; poly: Poly; bb: Rect };

/** Spatial hash of obstacles per side. */
export class Grid<K extends string = string> {
  private cells = new Map<string, number[]>();
  items: Array<GridItem<K> | null> = [];
  constructor(private readonly cell = 2.0) {}

  private *keys(bb: Rect): Generator<string> {
    const c = this.cell;
    for (let gx = Math.floor(bb[0] / c); gx <= Math.floor(bb[2] / c); gx++) for (let gy = Math.floor(bb[1] / c); gy <= Math.floor(bb[3] / c); gy++) yield `${gx},${gy}`;
  }

  add(kind: K, owner: unknown, poly: Poly, bb?: Rect): number {
    const box = bb ?? bboxOf(poly);
    const i = this.items.length;
    this.items.push({ kind, owner, poly, bb: box });
    for (const k of this.keys(box)) (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
    return i;
  }

  remove(i: number): void {
    const it = this.items[i];
    if (!it) return;
    for (const k of this.keys(it.bb)) {
      const l = this.cells.get(k);
      if (l) l.splice(l.indexOf(i), 1);
    }
    this.items[i] = null;
  }

  /** Items whose cells meet `r` (each once, in cell order). */
  *near(r: Rect): Generator<[number, GridItem<K> | null]> {
    const seen = new Set<number>();
    for (const k of this.keys(r))
      for (const i of this.cells.get(k) ?? [])
        if (!seen.has(i)) {
          seen.add(i);
          yield [i, this.items[i]!];
        }
  }
}
