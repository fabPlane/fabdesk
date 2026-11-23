/**
 * Two-pad net length along the connected centreline (toolkit tools/net_path_measure.py), not the sum of the net's
 * segments: every segment is split where a same-layer segment of the net crosses or T-joins it and where a pad or via
 * of the net sits on it, layers are joined only at vias and plated pads, and the shortest path from one pad to the other
 * is taken (Dijkstra). Tails and branches off the path are left out, so for a pair this is the length the signal runs;
 * the segment sum counts both. On C6 (kb-fix112) the USB pair's segment sums differed by 0.11 mm and its connected paths
 * by 0.841 mm. The pad-centre contact region is left out and vias count zero barrel length: a copper-path audit, not a
 * field solver or a timing guarantee.
 *
 * The geometry follows shapely/GEOS as the script calls it on two-point lines: `intersection` (a crossing point; a
 * collinear overlap or a zero-length segment gives none), `project`, `distance`, `interpolate`; node positions are
 * rounded to 6 decimals as the script's dictionary keys are.
 */
import { viaSpan, type Board, type Pad } from "../board";
import { padLayers } from "./pairs";

export interface NetPath {
  net: string;
  /** The two pads, `REF.PAD`, in board order (the path runs from the first). */
  pads: string[];
  /** Length of the shortest connected path between the pads, mm; null when they are not connected by the net's copper. */
  connected_path_mm: number | null;
  /** Sum of every segment of the net, mm (what a segment sum reports). */
  all_segments_mm: number;
  note: string;
}

export const NETPATH_NOTE = "Pad-centre contact region omitted; vias have zero barrel length. Compare with native DRC and geometry.";

type P = readonly [number, number];

// ---- GEOS on one segment (algorithm::Distance, LengthIndexedLine, LineIntersector)

const segLen = (a: P, b: P) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
};
const ptDist = (a: P, b: P) => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
};
const eq = (a: P, b: P) => a[0] === b[0] && a[1] === b[1];

/** Distance::pointToSegment. */
export function pointToSegment(p: P, a: P, b: P): number {
  if (eq(a, b)) return ptDist(p, a);
  const len2 = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
  const r = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
  if (r <= 0.0) return ptDist(p, a);
  if (r >= 1.0) return ptDist(p, b);
  const s = ((a[1] - p[1]) * (b[0] - a[0]) - (a[0] - p[0]) * (b[1] - a[1])) / len2;
  return Math.abs(s) * Math.sqrt(len2);
}

/** LineString.project on a two-point line: distance along it of the nearest point (LengthIndexOfPoint). */
export function project(a: P, b: P, p: P): number {
  if (eq(a, b)) return 0.0;
  let r: number;
  if (eq(p, a)) r = 0.0;
  else if (eq(p, b)) r = 1.0;
  else {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    r = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  }
  if (r <= 0.0) return 0.0;
  if (r <= 1.0) return r * segLen(a, b);
  return segLen(a, b);
}

/** LineString.interpolate on a two-point line (LengthLocationMap + LinearLocation.pointAlongSegmentByFraction). */
export function interpolate(a: P, b: P, x: number): P {
  if (x <= 0.0) return a;
  const L = segLen(a, b);
  if (!(L > x)) return b;
  const frac = x / L;
  if (frac <= 0.0) return a;
  if (frac >= 1.0) return b;
  return [(b[0] - a[0]) * frac + a[0], (b[1] - a[1]) * frac + a[1]];
}

// exact orientation sign: doubles as integers times 2^-1100, so the determinant is computed without rounding
const SCALE = 1100n;
function exact(x: number): bigint {
  if (x === 0) return 0n;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const e = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: bigint;
  if (e === 0) exp = -1074n;
  else {
    m |= 1n << 52n;
    exp = BigInt(e) - 1075n;
  }
  return sign * (m << (SCALE + exp));
}

/** Orientation::index(p1, p2, q): 1 left, -1 right, 0 collinear (exact, as GEOS's double-double fallback decides). */
export function orientation(p1: P, p2: P, q: P): number {
  // CGAlgorithmsDD::orientationIndexFilter, then the exact sign where the filter cannot decide
  const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const detleft = (p1[0] - q[0]) * (p2[1] - q[1]);
  const detright = (p1[1] - q[1]) * (p2[0] - q[0]);
  const det = detleft - detright;
  let detsum: number;
  if (detleft > 0.0) {
    if (detright <= 0.0) return sgn(det);
    detsum = detleft + detright;
  } else if (detleft < 0.0) {
    if (detright >= 0.0) return sgn(det);
    detsum = -detleft - detright;
  } else return sgn(det);
  const errbound = 1e-15 * detsum;
  if (det >= errbound || -det >= errbound) return sgn(det);
  const [ax, ay, bx, by, qx, qy] = [p1[0], p1[1], p2[0], p2[1], q[0], q[1]].map(exact) as [bigint, bigint, bigint, bigint, bigint, bigint];
  const d = (bx - ax) * (qy - by) - (by - ay) * (qx - bx);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
}

const inEnv = (a: P, b: P, q: P) => q[0] >= Math.min(a[0], b[0]) && q[0] <= Math.max(a[0], b[0]) && q[1] >= Math.min(a[1], b[1]) && q[1] <= Math.max(a[1], b[1]);
const envMeet = (p1: P, p2: P, q1: P, q2: P) =>
  !(Math.min(q1[0], q2[0]) > Math.max(p1[0], p2[0]) || Math.max(q1[0], q2[0]) < Math.min(p1[0], p2[0]) || Math.min(q1[1], q2[1]) > Math.max(p1[1], p2[1]) || Math.max(q1[1], q2[1]) < Math.min(p1[1], p2[1]));

/** algorithm::Intersection::intersection: homogeneous coordinates, conditioned on the envelopes' common midpoint. */
function properPoint(p1: P, p2: P, q1: P, q2: P): P | null {
  const intMinX = Math.max(Math.min(p1[0], p2[0]), Math.min(q1[0], q2[0]));
  const intMaxX = Math.min(Math.max(p1[0], p2[0]), Math.max(q1[0], q2[0]));
  const intMinY = Math.max(Math.min(p1[1], p2[1]), Math.min(q1[1], q2[1]));
  const intMaxY = Math.min(Math.max(p1[1], p2[1]), Math.max(q1[1], q2[1]));
  const midx = (intMinX + intMaxX) / 2.0;
  const midy = (intMinY + intMaxY) / 2.0;
  const p1x = p1[0] - midx, p1y = p1[1] - midy, p2x = p2[0] - midx, p2y = p2[1] - midy;
  const q1x = q1[0] - midx, q1y = q1[1] - midy, q2x = q2[0] - midx, q2y = q2[1] - midy;
  const px = p1y - p2y, py = p2x - p1x, pw = p1x * p2y - p2x * p1y;
  const qx = q1y - q2y, qy = q2x - q1x, qw = q1x * q2y - q2x * q1y;
  const x = py * qw - qy * pw;
  const y = qx * pw - px * qw;
  const w = px * qy - qx * py;
  const xi = x / w, yi = y / w;
  return Number.isFinite(xi) && Number.isFinite(yi) ? [xi + midx, yi + midy] : null;
}

function nearestEndpoint(p1: P, p2: P, q1: P, q2: P): P {
  let best = p1;
  let min = pointToSegment(p1, q1, q2);
  for (const [pt, a, b] of [[p2, q1, q2], [q1, p1, p2], [q2, p1, p2]] as const) {
    const d = pointToSegment(pt, a, b);
    if (d < min) {
      min = d;
      best = pt;
    }
  }
  return best;
}

/**
 * The point where two segments meet, as shapely's `intersection` of two two-point lines gives it: null when they do not
 * meet, overlap along a stretch (the result is a line), or either has zero length (GEOS drops it).
 */
export function segmentIntersection(p1: P, p2: P, q1: P, q2: P): P | null {
  if (eq(p1, p2) || eq(q1, q2)) return null;
  if (!envMeet(p1, p2, q1, q2)) return null;
  const Pq1 = orientation(p1, p2, q1);
  const Pq2 = orientation(p1, p2, q2);
  if ((Pq1 > 0 && Pq2 > 0) || (Pq1 < 0 && Pq2 < 0)) return null;
  const Qp1 = orientation(q1, q2, p1);
  const Qp2 = orientation(q1, q2, p2);
  if ((Qp1 > 0 && Qp2 > 0) || (Qp1 < 0 && Qp2 < 0)) return null;
  if (Pq1 === 0 && Pq2 === 0 && Qp1 === 0 && Qp2 === 0) {
    // collinear: a point only when they touch end to end
    const q1inP = inEnv(p1, p2, q1), q2inP = inEnv(p1, p2, q2), p1inQ = inEnv(q1, q2, p1), p2inQ = inEnv(q1, q2, p2);
    if ((q1inP && q2inP) || (p1inQ && p2inQ)) return null;
    if (q1inP && p1inQ) return eq(q1, p1) && !q2inP && !p2inQ ? q1 : null;
    if (q1inP && p2inQ) return eq(q1, p2) && !q2inP && !p1inQ ? q1 : null;
    if (q2inP && p1inQ) return eq(q2, p1) && !q1inP && !p2inQ ? q2 : null;
    if (q2inP && p2inQ) return eq(q2, p2) && !q1inP && !p1inQ ? q2 : null;
    return null;
  }
  if (Pq1 === 0 || Pq2 === 0 || Qp1 === 0 || Qp2 === 0) {
    if (eq(p1, q1) || eq(p1, q2)) return p1;
    if (eq(p2, q1) || eq(p2, q2)) return p2;
    if (Pq1 === 0) return q1;
    if (Pq2 === 0) return q2;
    if (Qp1 === 0) return p1;
    return p2;
  }
  let pt = properPoint(p1, p2, q1, q2) ?? nearestEndpoint(p1, p2, q1, q2);
  if (!(inEnv(p1, p2, pt) && inEnv(q1, q2, pt))) pt = nearestEndpoint(p1, p2, q1, q2);
  return pt;
}

// ---- the measurement

class Queue {
  private a: Array<[number, number, string]> = [];
  private less = (i: number, j: number) => this.a[i]![0] < this.a[j]![0] || (this.a[i]![0] === this.a[j]![0] && this.a[i]![1] < this.a[j]![1]);
  private swap(i: number, j: number) {
    [this.a[i], this.a[j]] = [this.a[j]!, this.a[i]!];
  }
  push(x: [number, number, string]) {
    this.a.push(x);
    for (let i = this.a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number, string] | undefined {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length && last) {
      this.a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.a.length && this.less(l, m)) m = l;
        if (r < this.a.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/** Python's round(v, 6) as a key (toFixed rounds the exact binary value; -0 prints as 0, as -0.0 == 0.0 in a tuple). */
const r6 = (v: number) => String(Number(v.toFixed(6)));

/**
 * Measure `net` (exactly two pads, or two named by `endpoints` as `REF.PAD`) on `board`; `stack` is the board's copper
 * layers front to back. Throws when the net does not have two pads.
 */
export function measureNetPath(board: Board, net: string, stack: readonly string[], endpoints?: readonly string[]): NetPath {
  let ps: Pad[] = board.pads.filter((p) => p.net === net);
  if (endpoints?.length) ps = ps.filter((p) => endpoints.includes(`${p.ref}.${p.pad}`));
  const ss = board.segments.filter((s) => s.net === net);
  const vs = board.vias.filter((v) => v.net === net);
  if (ps.length !== 2) throw new Error(`${net}: expected 2 pads, got ${ps.length}`);
  const adj = new Map<string, Array<[string, number]>>();
  const node = (q: P, L: string) => `${r6(q[0])},${r6(q[1])},${L}`;
  const edge = (a: string, b: string, w: number) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, w]);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push([a, w]);
  };
  const lidx = (l: string) => stack.indexOf(l);
  const span = (v: (typeof vs)[number]) => viaSpan(v, stack).map(lidx) as [number, number];
  for (const [i, s] of ss.entries()) {
    const L = s.layer;
    const cuts = new Set<number>([0.0, segLen(s.a, s.b)]);
    const attachments: Array<[number, string, number]> = [];
    for (const [j, t] of ss.entries()) {
      if (j === i || s.layer !== t.layer) continue;
      const hit = segmentIntersection(s.a, s.b, t.a, t.b);
      if (hit) cuts.add(project(s.a, s.b, hit));
      // a T join may sit off the centreline: the true end is joined to its projection, never shortening across a gap
      for (const q of [t.a, t.b]) {
        const d = pointToSegment(q, s.a, s.b);
        if (d < (s.w + t.w) / 2 - 1e-6) {
          const x = project(s.a, s.b, q);
          cuts.add(x);
          edge(node(q, L), node(interpolate(s.a, s.b, x), L), d);
        }
      }
    }
    for (const [pi, p] of ps.entries()) {
      if (!padLayers(p, stack).includes(L)) continue;
      const pt: P = [p.x, p.y];
      const x = project(s.a, s.b, pt);
      const d = pointToSegment(pt, s.a, s.b);
      // a conservative circular pad radius, for contacts near the pad centre only
      if (d <= p.r + s.w / 2) {
        cuts.add(x);
        attachments.push([x, `pad:${pi}`, 0.0]);
      }
    }
    for (const [vi, v] of vs.entries()) {
      const [lo, hi] = span(v);
      const k = lidx(L);
      if (!(lo <= k && k <= hi)) continue;
      const pt: P = [v.x, v.y];
      const x = project(s.a, s.b, pt);
      const d = pointToSegment(pt, s.a, s.b);
      if (d <= v.size / 2 + s.w / 2) {
        cuts.add(x);
        attachments.push([x, `via:${vi}`, d]);
      }
    }
    const cs = [...cuts].sort((a, b) => a - b);
    for (let k = 0; k + 1 < cs.length; k++) edge(node(interpolate(s.a, s.b, cs[k]!), L), node(interpolate(s.a, s.b, cs[k + 1]!), L), cs[k + 1]! - cs[k]!);
    for (const [x, n, d] of attachments) edge(node(interpolate(s.a, s.b, x), L), n, d);
  }
  for (const [pi, p] of ps.entries())
    for (const [vi, v] of vs.entries()) {
      const [lo, hi] = span(v);
      const on = padLayers(p, stack).some((l) => lo <= lidx(l) && lidx(l) <= hi);
      if (on && Math.hypot(p.x - v.x, p.y - v.y) <= p.r + v.size / 2) edge(`pad:${pi}`, `via:${vi}`, 0.0);
    }
  const dist = new Map<string, number>([["pad:0", 0.0]]);
  const queue = new Queue();
  queue.push([0.0, 0, "pad:0"]);
  let counter = 0;
  while (queue.size) {
    const [d, , n] = queue.pop()!;
    if (d > dist.get(n)!) continue;
    for (const [k, w] of adj.get(n) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(k) ?? Infinity)) {
        dist.set(k, nd);
        counter++;
        queue.push([nd, counter, k]);
      }
    }
  }
  let total = 0;
  for (const s of ss) total += Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]);
  return { net, pads: ps.map((p) => `${p.ref}.${p.pad}`), connected_path_mm: dist.get("pad:1") ?? null, all_segments_mm: total, note: NETPATH_NOTE };
}

export interface PairPath {
  pair: string;
  p: NetPath | { net: string; error: string };
  n: NetPath | { net: string; error: string };
  /** |P - N| of the connected paths, mm; null unless both are connected two-pad paths. */
  mismatch_mm: number | null;
  /** |P - N| of the segment sums, mm, for comparison. */
  segment_mismatch_mm: number | null;
}

/** Connected-path lengths of each pair's two nets (a net without exactly two pads is reported, not measured). */
export function measurePairPaths(board: Board, pairs: ReadonlyArray<{ p: string; n: string }>, stack: readonly string[]): PairPath[] {
  const one = (net: string) => {
    try {
      return measureNetPath(board, net, stack);
    } catch (e) {
      return { net, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return pairs.map(({ p, n }) => {
    const mp = one(p);
    const mn = one(n);
    const ok = (m: typeof mp): m is NetPath => "pads" in m;
    const both = ok(mp) && ok(mn);
    return {
      pair: `${p} / ${n}`,
      p: mp,
      n: mn,
      mismatch_mm: both && mp.connected_path_mm !== null && mn.connected_path_mm !== null ? Math.abs(mp.connected_path_mm - mn.connected_path_mm) : null,
      segment_mismatch_mm: both ? Math.abs(mp.all_segments_mm - mn.all_segments_mm) : null,
    };
  });
}

/** One line per pair for `board_route pairs`. */
export function pairPathLines(rows: readonly PairPath[]): string[] {
  const f = (x: number) => x.toFixed(3);
  const side = (m: PairPath["p"]) => ("error" in m ? `${m.net} not measured (${m.error.replace(`${m.net}: `, "")})` : `${m.net} ${m.connected_path_mm === null ? "not connected" : f(m.connected_path_mm)} (segments ${f(m.all_segments_mm)})`);
  return rows.map((r) => `  ${r.pair}: ${side(r.p)}, ${side(r.n)}` + (r.mismatch_mm !== null ? `; mismatch ${f(r.mismatch_mm)} mm (segment sums ${f(r.segment_mismatch_mm!)})` : ""));
}
