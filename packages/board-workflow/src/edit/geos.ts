/**
 * The few GEOS (shapely 2 / GEOS 3.12) segment operations `flow/copper_plan.py` relies on, written as GEOS computes
 * them so a split point lands on the same double: LineString length, project, interpolate, point-segment distance, and
 * the noded crossing point of two segments (LineIntersector with exact orientation, Intersection::intersection with
 * midpoint conditioning). Two-point lines only.
 */
export type P = [number, number];

/** `Length::ofLine` / `Coordinate::distance` on one segment. */
export function segLen(a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

const eq = (p: P, q: P) => p[0] === q[0] && p[1] === q[1];

/** `LineSegment::projectionFactor`. */
function projectionFactor(p0: P, p1: P, p: P): number {
  if (eq(p, p0)) return 0;
  if (eq(p, p1)) return 1;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len2 = dx * dx + dy * dy;
  return ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / len2;
}

/** shapely `LineString([a, b]).project(Point(p))` (`LengthIndexOfPoint::segmentNearestMeasure`). */
export function project(a: P, b: P, p: P): number {
  const f = projectionFactor(a, b, p);
  if (f <= 0) return 0;
  if (f <= 1) return f * segLen(a, b);
  return segLen(a, b);
}

/** shapely `LineString([a, b]).interpolate(d)` (`LengthLocationMap::getLocationForward`, `pointAlongSegmentByFraction`). */
export function interpolate(a: P, b: P, d: number): P {
  if (d <= 0) return a;
  const L = segLen(a, b);
  if (L > d) {
    const frac = d / L;
    if (frac <= 0) return a;
    if (frac >= 1) return b;
    return [(b[0] - a[0]) * frac + a[0], (b[1] - a[1]) * frac + a[1]];
  }
  return b;
}

/** `Distance::pointToSegment` (shapely `LineString([a, b]).distance(Point(p))`). */
export function pointSegDist(p: P, a: P, b: P): number {
  if (a[0] === b[0] && a[1] === b[1]) return segLen(p, a);
  const len2 = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
  const r = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
  if (r <= 0) return segLen(p, a);
  if (r >= 1) return segLen(p, b);
  const s = ((a[1] - p[1]) * (b[0] - a[0]) - (a[0] - p[0]) * (b[1] - a[1])) / len2;
  return Math.abs(s) * Math.sqrt(len2);
}

// ---- exact orientation (GEOS uses a filter, then double-double; the exact sign agrees with it)
const view = new DataView(new ArrayBuffer(8));
/** x = m * 2^e with integer m (BigInt). */
function decompose(x: number): { m: bigint; e: number } {
  if (x === 0) return { m: 0n, e: 0 };
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = exp - 1075;
  }
  return { m: sign * m, e };
}

function exactSign(vals: number[], f: (b: bigint[]) => bigint): number {
  const ds = vals.map(decompose);
  const emin = Math.min(...ds.filter((d) => d.m !== 0n).map((d) => d.e), 0);
  const big = ds.map((d) => (d.m === 0n ? 0n : d.m << BigInt(d.e - emin)));
  const r = f(big);
  return r > 0n ? 1 : r < 0n ? -1 : 0;
}

/** `Orientation::index(p1, p2, q)`: the sign of (p2 - p1) x (q - p2), exactly. */
export function orientation(p1: P, p2: P, q: P): number {
  // GEOS orientationIndexFilter
  const detleft = (p1[0] - q[0]) * (p2[1] - q[1]);
  const detright = (p1[1] - q[1]) * (p2[0] - q[0]);
  const det = detleft - detright;
  let detsum: number;
  if (detleft > 0) {
    if (detright <= 0) return Math.sign(det);
    detsum = detleft + detright;
  } else if (detleft < 0) {
    if (detright >= 0) return Math.sign(det);
    detsum = -detleft - detright;
  } else return Math.sign(det);
  if (det >= 1e-15 * detsum || -det >= 1e-15 * detsum) return Math.sign(det);
  return exactSign([p1[0], p1[1], p2[0], p2[1], q[0], q[1]], ([ax, ay, bx, by, cx, cy]) => (bx! - ax!) * (cy! - by!) - (by! - ay!) * (cx! - bx!));
}

function envIntersects(p1: P, p2: P, q1: P, q2: P): boolean {
  if (Math.min(p1[0], p2[0]) > Math.max(q1[0], q2[0]) || Math.max(p1[0], p2[0]) < Math.min(q1[0], q2[0])) return false;
  if (Math.min(p1[1], p2[1]) > Math.max(q1[1], q2[1]) || Math.max(p1[1], p2[1]) < Math.min(q1[1], q2[1])) return false;
  return true;
}

/** `Intersection::intersection`: the lines' crossing, conditioned on the middle of the envelopes' overlap. */
function lineCross(p1: P, p2: P, q1: P, q2: P): P | null {
  const intMinX = Math.max(Math.min(p1[0], p2[0]), Math.min(q1[0], q2[0]));
  const intMaxX = Math.min(Math.max(p1[0], p2[0]), Math.max(q1[0], q2[0]));
  const intMinY = Math.max(Math.min(p1[1], p2[1]), Math.min(q1[1], q2[1]));
  const intMaxY = Math.min(Math.max(p1[1], p2[1]), Math.max(q1[1], q2[1]));
  const midx = (intMinX + intMaxX) / 2;
  const midy = (intMinY + intMaxY) / 2;
  const p1x = p1[0] - midx, p1y = p1[1] - midy, p2x = p2[0] - midx, p2y = p2[1] - midy;
  const q1x = q1[0] - midx, q1y = q1[1] - midy, q2x = q2[0] - midx, q2y = q2[1] - midy;
  const px = p1y - p2y, py = p2x - p1x, pw = p1x * p2y - p2x * p1y;
  const qx = q1y - q2y, qy = q2x - q1x, qw = q1x * q2y - q2x * q1y;
  const x = py * qw - qy * pw;
  const y = qx * pw - px * qw;
  const w = px * qy - qx * py;
  const xi = x / w, yi = y / w;
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return null;
  return [xi + midx, yi + midy];
}

function nearestEndpoint(p1: P, p2: P, q1: P, q2: P): P {
  let best = p1;
  let min = pointSegDist(p1, q1, q2);
  for (const [pt, d] of [[p2, pointSegDist(p2, q1, q2)], [q1, pointSegDist(q1, p1, p2)], [q2, pointSegDist(q2, p1, p2)]] as Array<[P, number]>)
    if (d < min) {
      min = d;
      best = pt;
    }
  return best;
}

const inEnv = (p: P, a: P, b: P) => p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);

/**
 * shapely `LineString([p1, p2]).intersection(LineString([q1, q2]))` when it is a single point (`LineIntersector::computeIntersect`):
 * an endpoint lying on the other segment is copied exactly, a proper crossing is computed. Collinear overlaps (a line, or a
 * shared endpoint the caller adds anyway) and no intersection give null.
 */
export function crossPoint(p1: P, p2: P, q1: P, q2: P): P | null {
  if (!envIntersects(p1, p2, q1, q2)) return null;
  const pq1 = orientation(p1, p2, q1);
  const pq2 = orientation(p1, p2, q2);
  if ((pq1 > 0 && pq2 > 0) || (pq1 < 0 && pq2 < 0)) return null;
  const qp1 = orientation(q1, q2, p1);
  const qp2 = orientation(q1, q2, p2);
  if ((qp1 > 0 && qp2 > 0) || (qp1 < 0 && qp2 < 0)) return null;
  if (pq1 === 0 && pq2 === 0 && qp1 === 0 && qp2 === 0) {
    // collinear: a single shared endpoint is a point; it is also within any width of both, so the caller's endpoint cut has it
    return null;
  }
  if (pq1 === 0 || pq2 === 0 || qp1 === 0 || qp2 === 0) {
    if (eq(p1, q1) || eq(p1, q2)) return p1;
    if (eq(p2, q1) || eq(p2, q2)) return p2;
    if (pq1 === 0) return q1;
    if (pq2 === 0) return q2;
    if (qp1 === 0) return p1;
    return p2;
  }
  let pt = lineCross(p1, p2, q1, q2) ?? nearestEndpoint(p1, p2, q1, q2);
  if (!(inEnv(pt, p1, p2) && inEnv(pt, q1, q2))) pt = nearestEndpoint(p1, p2, q1, q2);
  return pt;
}
