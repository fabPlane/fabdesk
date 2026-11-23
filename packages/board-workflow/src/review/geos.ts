/**
 * The few planar operations the inner-power audit (`current-paths.ts`) takes from shapely / GEOS 3.12, computed the way
 * GEOS computes them so the audit's nodes and resistances equal the toolkit's bit for bit: pad outlines as GEOS buffers
 * them (24 segments per quadrant, ring order and start point included), polygon / line / point distances with GEOS's
 * containment shortcut, `nearest_points` (first zero-distance ring segment wins), segment intersection points
 * (LineIntersector with its conditioning and envelope fallback) and `project(normalized=True)`.
 *
 * Points are [x, y]; a ring is closed (last point equals the first). GEOS's double-double orientation fallback is an
 * exact BigInt determinant here (it only runs when the floating filter cannot decide).
 */

export type XY = readonly [number, number];
export type Ring = XY[];

const PI = Math.PI;

// ---------------------------------------------------------------- orientation (CGAlgorithmsDD::orientationIndex)

function exactParts(x: number): [bigint, number] {
  // x = m * 2^e with m an integer (doubles are dyadic rationals)
  if (x === 0) return [0n, 0];
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  return [sign * mant, e];
}

/** Exact sign of (b - a) as a scaled BigInt pair sharing exponent `e`. */
function exactSub(a: number, b: number, e: number): bigint {
  const [ma, ea] = exactParts(a), [mb, eb] = exactParts(b);
  return (mb << BigInt(eb - e)) - (ma << BigInt(ea - e));
}

function exactOrientation(p1x: number, p1y: number, p2x: number, p2y: number, qx: number, qy: number): number {
  const e = -1074;
  const dx1 = exactSub(p1x, p2x, e), dy1 = exactSub(p1y, p2y, e), dx2 = exactSub(p2x, qx, e), dy2 = exactSub(p2y, qy, e);
  const d = dx1 * dy2 - dy1 * dx2;
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

export function orientationIndex(p1: XY, p2: XY, q: XY): number {
  const [pax, pay] = p1, [pbx, pby] = p2, [pcx, pcy] = q;
  const detleft = (pax - pcx) * (pby - pcy);
  const detright = (pay - pcy) * (pbx - pcx);
  const det = detleft - detright;
  const sgn = (d: number) => (d > 0 ? 1 : d < 0 ? -1 : 0);
  let detsum: number;
  if (detleft > 0) {
    if (detright <= 0) return sgn(det);
    detsum = detleft + detright;
  } else if (detleft < 0) {
    if (detright >= 0) return sgn(det);
    detsum = -detleft - detright;
  } else return sgn(det);
  const errbound = 1e-15 * detsum;
  if (det >= errbound || -det >= errbound) return sgn(det);
  return exactOrientation(pax, pay, pbx, pby, pcx, pcy);
}

// ---------------------------------------------------------------- distances

const ptDist = (a: XY, b: XY) => {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
};

/** Distance::pointToSegment. */
export function pointToSegment(p: XY, A: XY, B: XY): number {
  if (A[0] === B[0] && A[1] === B[1]) return ptDist(p, A);
  const len2 = (B[0] - A[0]) * (B[0] - A[0]) + (B[1] - A[1]) * (B[1] - A[1]);
  const r = ((p[0] - A[0]) * (B[0] - A[0]) + (p[1] - A[1]) * (B[1] - A[1])) / len2;
  if (r <= 0) return ptDist(p, A);
  if (r >= 1) return ptDist(p, B);
  const s = ((A[1] - p[1]) * (B[0] - A[0]) - (A[0] - p[0]) * (B[1] - A[1])) / len2;
  return Math.abs(s) * Math.sqrt(len2);
}

function envIntersects(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
  let minq = Math.min(q1[0], q2[0]), maxq = Math.max(q1[0], q2[0]);
  let minp = Math.min(p1[0], p2[0]), maxp = Math.max(p1[0], p2[0]);
  if (minp > maxq || maxp < minq) return false;
  minq = Math.min(q1[1], q2[1]);
  maxq = Math.max(q1[1], q2[1]);
  minp = Math.min(p1[1], p2[1]);
  maxp = Math.max(p1[1], p2[1]);
  return !(minp > maxq || maxp < minq);
}

const envCovers = (p1: XY, p2: XY, q: XY) =>
  q[0] >= Math.min(p1[0], p2[0]) && q[0] <= Math.max(p1[0], p2[0]) && q[1] >= Math.min(p1[1], p2[1]) && q[1] <= Math.max(p1[1], p2[1]);

/** Distance::segmentToSegment. */
export function segmentToSegment(A: XY, B: XY, C: XY, D: XY): number {
  if (A[0] === B[0] && A[1] === B[1]) return pointToSegment(A, C, D);
  if (C[0] === D[0] && C[1] === D[1]) return pointToSegment(D, A, B);
  let noIntersection = false;
  if (!envIntersects(A, B, C, D)) noIntersection = true;
  else {
    const denom = (B[0] - A[0]) * (D[1] - C[1]) - (B[1] - A[1]) * (D[0] - C[0]);
    if (denom === 0) noIntersection = true;
    else {
      const rNum = (A[1] - C[1]) * (D[0] - C[0]) - (A[0] - C[0]) * (D[1] - C[1]);
      const sNum = (A[1] - C[1]) * (B[0] - A[0]) - (A[0] - C[0]) * (B[1] - A[1]);
      const s = sNum / denom, r = rNum / denom;
      if (r < 0 || r > 1 || s < 0 || s > 1) noIntersection = true;
    }
  }
  if (noIntersection) return Math.min(pointToSegment(A, C, D), Math.min(pointToSegment(B, C, D), Math.min(pointToSegment(C, A, B), pointToSegment(D, A, B))));
  return 0;
}

// ---------------------------------------------------------------- LineIntersector (point of intersection only)

function nearestEndpoint(p1: XY, p2: XY, q1: XY, q2: XY): XY {
  let nearest = p1;
  let minDist = pointToSegment(p1, q1, q2);
  let d = pointToSegment(p2, q1, q2);
  if (d < minDist) {
    minDist = d;
    nearest = p2;
  }
  d = pointToSegment(q1, p1, p2);
  if (d < minDist) {
    minDist = d;
    nearest = q1;
  }
  d = pointToSegment(q2, p1, p2);
  if (d < minDist) nearest = q2;
  return nearest;
}

function rawIntersection(p1: XY, p2: XY, q1: XY, q2: XY): XY | null {
  const minX0 = p1[0] < p2[0] ? p1[0] : p2[0], minY0 = p1[1] < p2[1] ? p1[1] : p2[1];
  const maxX0 = p1[0] > p2[0] ? p1[0] : p2[0], maxY0 = p1[1] > p2[1] ? p1[1] : p2[1];
  const minX1 = q1[0] < q2[0] ? q1[0] : q2[0], minY1 = q1[1] < q2[1] ? q1[1] : q2[1];
  const maxX1 = q1[0] > q2[0] ? q1[0] : q2[0], maxY1 = q1[1] > q2[1] ? q1[1] : q2[1];
  const intMinX = minX0 > minX1 ? minX0 : minX1, intMaxX = maxX0 < maxX1 ? maxX0 : maxX1;
  const intMinY = minY0 > minY1 ? minY0 : minY1, intMaxY = maxY0 < maxY1 ? maxY0 : maxY1;
  const midx = (intMinX + intMaxX) / 2.0, midy = (intMinY + intMaxY) / 2.0;
  const p1x = p1[0] - midx, p1y = p1[1] - midy, p2x = p2[0] - midx, p2y = p2[1] - midy;
  const q1x = q1[0] - midx, q1y = q1[1] - midy, q2x = q2[0] - midx, q2y = q2[1] - midy;
  const px = p1y - p2y, py = p2x - p1x, pw = p1x * p2y - p2x * p1y;
  const qx = q1y - q2y, qy = q2x - q1x, qw = q1x * q2y - q2x * q1y;
  const x = py * qw - qy * pw, y = qx * pw - px * qw, w = px * qy - qx * py;
  const xInt = x / w, yInt = y / w;
  if (!Number.isFinite(xInt) || !Number.isFinite(yInt)) return null;
  return [xInt + midx, yInt + midy];
}

function collinearIntersection(p1: XY, p2: XY, q1: XY, q2: XY): XY | null {
  const q1inP = envCovers(p1, p2, q1), q2inP = envCovers(p1, p2, q2), p1inQ = envCovers(q1, q2, p1), p2inQ = envCovers(q1, q2, p2);
  if (q1inP && q2inP) return q1;
  if (p1inQ && p2inQ) return p1;
  if (q1inP && p1inQ) return q1;
  if (q1inP && p2inQ) return q1;
  if (q2inP && p1inQ) return q2;
  if (q2inP && p2inQ) return q2;
  return null;
}

const eq = (a: XY, b: XY) => a[0] === b[0] && a[1] === b[1];

/** LineIntersector::computeIntersection(p1, p2, q1, q2) then getIntersection(0); null when the segments miss. */
export function segmentIntersection(p1: XY, p2: XY, q1: XY, q2: XY): XY | null {
  if (!envIntersects(p1, p2, q1, q2)) return null;
  const Pq1 = orientationIndex(p1, p2, q1), Pq2 = orientationIndex(p1, p2, q2);
  if ((Pq1 > 0 && Pq2 > 0) || (Pq1 < 0 && Pq2 < 0)) return null;
  const Qp1 = orientationIndex(q1, q2, p1), Qp2 = orientationIndex(q1, q2, p2);
  if ((Qp1 > 0 && Qp2 > 0) || (Qp1 < 0 && Qp2 < 0)) return null;
  if (Pq1 === 0 && Pq2 === 0 && Qp1 === 0 && Qp2 === 0) return collinearIntersection(p1, p2, q1, q2);
  if (Pq1 === 0 || Pq2 === 0 || Qp1 === 0 || Qp2 === 0) {
    if (eq(p1, q1) || eq(p1, q2)) return p1;
    if (eq(p2, q1) || eq(p2, q2)) return p2;
    if (Pq1 === 0) return q1;
    if (Pq2 === 0) return q2;
    if (Qp1 === 0) return p1;
    return p2;
  }
  let pt = rawIntersection(p1, p2, q1, q2) ?? nearestEndpoint(p1, p2, q1, q2);
  if (!(envCovers(p1, p2, pt) && envCovers(q1, q2, pt))) pt = nearestEndpoint(p1, p2, q1, q2);
  return pt;
}

// ---------------------------------------------------------------- LineSegment

function projectionFactor(p0: XY, p1: XY, p: XY): number {
  if (eq(p, p0)) return 0;
  if (eq(p, p1)) return 1;
  if (eq(p0, p1)) return 0;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const len2 = dx * dx + dy * dy;
  return ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / len2;
}

function closestPoint(p0: XY, p1: XY, p: XY): XY {
  const f = projectionFactor(p0, p1, p);
  if (f > 0 && f < 1) return f === 1 ? p1 : [p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])];
  return ptDist(p0, p) < ptDist(p1, p) ? p0 : p1;
}

/** LineSegment::closestPoints: [on segment a, on segment b]. */
export function closestPoints(a0: XY, a1: XY, b0: XY, b1: XY): [XY, XY] {
  const ip = segmentIntersection(a0, a1, b0, b1);
  if (ip) return [ip, ip];
  const c00 = closestPoint(a0, a1, b0);
  let min = ptDist(c00, b0);
  let out: [XY, XY] = [c00, b0];
  const c01 = closestPoint(a0, a1, b1);
  let d = ptDist(c01, b1);
  if (d < min) {
    min = d;
    out = [c01, b1];
  }
  const c10 = closestPoint(b0, b1, a0);
  d = ptDist(c10, a0);
  if (d < min) {
    min = d;
    out = [a0, c10];
  }
  const c11 = closestPoint(b0, b1, a1);
  d = ptDist(c11, a1);
  if (d < min) out = [a1, c11];
  return out;
}

// ---------------------------------------------------------------- point in ring (RayCrossingCounter)

/** True when `p` is inside or on the ring (GEOS: not EXTERIOR). */
export function inRing(p: XY, ring: Ring): boolean {
  let crossings = 0;
  for (let i = 1; i < ring.length; i++) {
    const p1 = ring[i]!, p2 = ring[i - 1]!;
    if (p1[0] < p[0] && p2[0] < p[0]) continue;
    if (p[0] === p2[0] && p[1] === p2[1]) return true;
    if (p1[1] === p[1] && p2[1] === p[1]) {
      const minx = Math.min(p1[0], p2[0]), maxx = Math.max(p1[0], p2[0]);
      if (p[0] >= minx && p[0] <= maxx) return true;
      continue;
    }
    if ((p1[1] > p[1] && p2[1] <= p[1]) || (p2[1] > p[1] && p1[1] <= p[1])) {
      let sign = orientationIndex(p1, p2, p);
      if (sign === 0) return true;
      if (p2[1] < p1[1]) sign = -sign;
      if (sign > 0) crossings++;
    }
  }
  return crossings % 2 === 1;
}

function ringEnvelopeHas(ring: Ring, p: XY): boolean {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return p[0] >= minx && p[0] <= maxx && p[1] >= miny && p[1] <= maxy;
}

const inPolygon = (p: XY, ring: Ring) => ringEnvelopeHas(ring, p) && inRing(p, ring);

// ---------------------------------------------------------------- DistanceOp for polygon (pad) against point / segment

/** `polygon.distance(Point(p))`. */
export function polygonPointDistance(ring: Ring, p: XY): number {
  if (inPolygon(p, ring)) return 0;
  let min = Infinity;
  for (let i = 0; i + 1 < ring.length; i++) {
    const d = pointToSegment(p, ring[i]!, ring[i + 1]!);
    if (d < min) min = d;
    if (min <= 0) return 0;
  }
  return min;
}

/** `polygon.distance(LineString([a, b]))` (containment tested with the line's first point). */
export function polygonSegmentDistance(ring: Ring, a: XY, b: XY): number {
  if (inPolygon(a, ring)) return 0;
  let min = Infinity;
  for (let i = 0; i + 1 < ring.length; i++) {
    const d = segmentToSegment(ring[i]!, ring[i + 1]!, a, b);
    if (d < min) min = d;
    if (min <= 0) return min;
  }
  return min;
}

/** `nearest_points(LineString([a, b]), polygon)[0]`: the point on the segment. */
export function segmentPolygonNearest(a: XY, b: XY, ring: Ring): XY {
  if (inPolygon(a, ring)) return a;
  let min = Infinity;
  let best: XY = a;
  for (let j = 0; j + 1 < ring.length; j++) {
    const d = segmentToSegment(a, b, ring[j]!, ring[j + 1]!);
    if (d < min) {
      min = d;
      best = closestPoints(a, b, ring[j]!, ring[j + 1]!)[0];
    }
    if (min <= 0) break;
  }
  return best;
}

/** `LineString([a, b]).project(p, normalized=True)` (GEOSProjectNormalized). */
export function projectNormalized(a: XY, b: XY, p: XY): number {
  const len = ptDist(a, b);
  const f = projectionFactor(a, b, p);
  const d = f <= 0 ? 0 : f <= 1 ? 0 + f * len : 0 + len;
  if (d === 0 && len === 0) return 0;
  if (d < 0 || !Number.isFinite(d) || len === 0) return -1;
  return d / len;
}

// ---------------------------------------------------------------- GEOS buffers (quadrant segments 24, round caps/joins)

const QUANTUM = PI / 2.0 / 24;

class SegList {
  pts: XY[] = [];
  constructor(private readonly minDist: number) {}
  add(p: XY) {
    const last = this.pts[this.pts.length - 1];
    if (last && ptDist(p, last) < this.minDist) return;
    this.pts.push(p);
  }
  close() {
    const s = this.pts[0], l = this.pts[this.pts.length - 1];
    if (s && l && !eq(s, l)) this.pts.push(s);
  }
}

function fillet(seg: SegList, p: XY, startAngle: number, endAngle: number, direction: number, radius: number) {
  const dirFactor = direction === -1 ? -1 : 1;
  const total = Math.abs(startAngle - endAngle);
  const nSegs = Math.trunc(total / QUANTUM + 0.5);
  if (nSegs < 1) return;
  const inc = total / nSegs;
  for (let i = 0; i < nSegs; i++) {
    const ang = startAngle + dirFactor * i * inc;
    seg.add([p[0] + radius * Math.cos(ang), p[1] + radius * Math.sin(ang)]);
  }
}

function filletBetween(seg: SegList, p: XY, p0: XY, p1: XY, direction: number, radius: number) {
  let start = Math.atan2(p0[1] - p[1], p0[0] - p[0]);
  const end = Math.atan2(p1[1] - p[1], p1[0] - p[0]);
  if (direction === -1) {
    if (start <= end) start += 2.0 * PI;
  } else if (start >= end) start -= 2.0 * PI;
  seg.add(p0);
  fillet(seg, p, start, end, direction, radius);
  seg.add(p1);
}

function offsetSegment(s0: XY, s1: XY, left: boolean, d: number): [XY, XY] {
  const sideSign = left ? 1 : -1;
  const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = (sideSign * d * dx) / len, uy = (sideSign * d * dy) / len;
  return [
    [s0[0] - uy, s0[1] + ux],
    [s1[0] - uy, s1[1] + ux],
  ];
}

/** The GEOS output ring: clockwise, keeping the generated start point. */
function asOutput(pts: XY[]): Ring {
  let area = 0;
  for (let i = 0; i + 1 < pts.length; i++) area += pts[i]![0] * pts[i + 1]![1] - pts[i + 1]![0] * pts[i]![1];
  if (area <= 0) return pts;
  return [pts[0]!, ...pts.slice(1, -1).reverse(), pts[0]!];
}

/** `Point(c).buffer(r, resolution=24)`. */
export function circleRing(c: XY, r: number): Ring {
  const seg = new SegList(r * 1e-6);
  seg.add([c[0] + r, c[1]]);
  fillet(seg, c, 0.0, 2.0 * PI, -1, r);
  seg.close();
  return asOutput(seg.pts);
}

/** `LineString([p0, p1]).buffer(d, resolution=24)` (round caps). */
export function stadiumRing(p0: XY, p1: XY, d: number): Ring {
  const seg = new SegList(d * 1e-6);
  const cap = (a: XY, b: XY) => {
    const offL = offsetSegment(a, b, true, d), offR = offsetSegment(a, b, false, d);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    seg.add(offL[1]);
    fillet(seg, b, ang + PI / 2.0, ang - PI / 2.0, -1, d);
    seg.add(offR[1]);
  };
  seg.add(offsetSegment(p0, p1, true, d)[1]);
  cap(p0, p1);
  seg.add(offsetSegment(p1, p0, true, d)[1]);
  cap(p1, p0);
  seg.close();
  return asOutput(seg.pts);
}

/** `box(x0, y0, x1, y1)` (shapely's counter-clockwise ring from (x1, y0)). */
export function boxRing(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
    [x1, y0],
  ];
}

/** `box(x0, y0, x1, y1).buffer(r, resolution=24)` for a box with area (rounded rectangle). */
export function roundedBoxRing(x0: number, y0: number, x1: number, y1: number, r: number): Ring {
  if (!(x1 > x0) || !(y1 > y0)) {
    // a flat or point box: GEOS gives a stadium / circle (start point and last bits may differ from GEOS here)
    if (x1 > x0) return stadiumRing([x0, y0], [x1, y0], r);
    if (y1 > y0) return stadiumRing([x0, y0], [x0, y1], r);
    return circleRing([x0, y0], r);
  }
  const ring = boxRing(x0, y0, x1, y1);
  // counter-clockwise shell: the offset is on the right; every corner is an outside (counter-clockwise) turn
  const seg = new SegList(r * 1e-6);
  const n = ring.length - 1;
  let s1 = ring[n - 1]!, s2 = ring[0]!;
  for (let i = 1; i <= n; i++) {
    const s0 = s1;
    s1 = s2;
    s2 = ring[i]!;
    const off0 = offsetSegment(s0, s1, false, r), off1 = offsetSegment(s1, s2, false, r);
    if (ptDist(off0[1], off1[0]) < r * 1e-3) {
      seg.add(off0[1]);
      continue;
    }
    if (i !== 1) seg.add(off0[1]);
    filletBetween(seg, s1, off0[1], off1[0], 1, r);
    seg.add(off1[0]);
  }
  seg.close();
  return asOutput(seg.pts);
}

/** shapely.affinity.rotate(ring, deg, origin=(0, 0)) then translate(dx, dy). */
export function rotateTranslate(ring: Ring, deg: number, dx: number, dy: number): Ring {
  const angle = (deg * PI) / 180.0;
  let c = Math.cos(angle), s = Math.sin(angle);
  if (Math.abs(c) < 2.5e-16) c = 0.0;
  if (Math.abs(s) < 2.5e-16) s = 0.0;
  return ring.map(([x, y]) => {
    const rx = c * x + -s * y + 0.0, ry = s * x + c * y + 0.0;
    return [1 * rx + 0 * ry + dx, 0 * rx + 1 * ry + dy] as XY;
  });
}
