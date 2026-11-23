/**
 * Layer-aware track/via resistance graph for declared-current nets (the toolkit's `review/current_paths.py`).
 *
 * Pads are terminals by their exported electrical type as well as their function (`power-stack.ts` `terminal`), so VD18,
 * IOVCC and the like are not silently dropped; a terminal the model cannot reach is an explicit gap. Track-only path
 * resistance ignores parallel pours (conservative when connected). Vias pay the declared minimum barrel plating, never a
 * zero-resistance layer jump, and copper joins layers only through a via or a pad on both layers. Same-layer tracks that
 * cross or overlap by width without sharing an endpoint join through a conservative lateral resistance.
 *
 * Geometry follows shapely / GEOS (`geos.ts`) so nodes and resistances equal the toolkit's.
 */
import { pyRound } from "../accept";
import {
  boxRing,
  circleRing,
  closestPoints,
  polygonPointDistance,
  polygonSegmentDistance,
  projectNormalized,
  rotateTranslate,
  roundedBoxRing,
  segmentPolygonNearest,
  segmentToSegment,
  stadiumRing,
  type Ring,
  type XY,
} from "./geos";

export interface PathTrack {
  a: XY;
  b: XY;
  w: number;
  layer: string;
}

export interface PathVia {
  x: number;
  y: number;
  layers: readonly string[];
  size: number;
}

export interface ContactShape {
  shape: string;
  size: [number, number];
  rotation: number;
  roundrect_ratio?: number;
}

export interface PathPad {
  x: number;
  y: number;
  layers: readonly string[];
  contact_r?: number;
  contact_shape?: ContactShape | null;
}

/** Neighbour, resistance (ohm), track index (null for a via barrel, a pad or a same-layer overlap). */
export type Edge = [number, number, number | null];

export interface GraphOptions {
  board_mm?: number;
  drill_mm?: number;
  plating_mm?: number;
}

const RHO = 1.72e-5; // ohm mm (20 C copper)

/** Python 3.12's built-in sum() over floats (Neumaier-compensated). */
export function pySum(xs: Iterable<number>): number {
  let sum = 0.0, c = 0.0;
  for (const x of xs) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return c && Number.isFinite(c) ? sum + c : sum;
}

const split = (x: number): [number, number] => {
  const t = x * 134217729.0; // Veltkamp: 2^27 + 1
  const hi = t - (t - x);
  return [hi, x - hi];
};
/** Dekker's exact product as (hi, lo). */
const dlMul = (x: number, y: number): [number, number] => {
  const [xh, xl] = split(x), [yh, yl] = split(y);
  const p = xh * yh, q = xh * yl + xl * yh, z = p + q;
  return [z, p - z + q + xl * yl];
};
const F64 = new DataView(new ArrayBuffer(8));
/** frexp's exponent: x = m 2^e with 0.5 <= m < 1 (x normal and positive). */
function frexpExp(x: number): number {
  F64.setFloat64(0, x);
  return ((F64.getUint32(0) >>> 20) & 0x7ff) - 1022;
}

/** Python's math.dist for two points: CPython 3.12's vector_norm (lossless scaling, compensated sums, one correction). */
export function mathDist(a: XY, b: XY): number {
  const v = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
  const max = Math.max(v[0]!, v[1]!);
  if (Number.isNaN(v[0]!) || Number.isNaN(v[1]!)) return NaN;
  if (max === Infinity) return max;
  if (max === 0 || max < 2.2250738585072014e-308) return max === 0 ? 0 : Math.hypot(v[0]!, v[1]!);
  const scale = 2 ** -frexpExp(max);
  let csum = 1.0, frac1 = 0.0, frac2 = 0.0;
  for (const x0 of v) {
    const x = x0 * scale;
    const [hi, lo] = dlMul(x, x);
    const s = csum + hi;
    frac2 += csum - s + hi;
    csum = s;
    frac1 += lo;
  }
  let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
  const [phi, plo] = dlMul(-h, h);
  const s = csum + phi;
  frac2 += csum - s + phi;
  csum = s;
  frac1 += plo;
  const x = csum - 1.0 + (frac1 + frac2);
  h += x / (2.0 * h);
  return h / scale;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** A pad's copper outline as the toolkit builds it with shapely. */
export function padRing(p: PathPad): Ring | null {
  const s = p.contact_shape;
  if (!s) return null;
  const [w, h] = s.size;
  let g: Ring;
  if (s.shape === "circle") g = circleRing([0, 0], Math.min(w, h) / 2);
  else if (s.shape === "oval") g = w >= h ? stadiumRing([-(w - h) / 2, 0], [(w - h) / 2, 0], h / 2) : stadiumRing([0, -(h - w) / 2], [0, (h - w) / 2], w / 2);
  else {
    const radius = s.shape === "roundrect" ? Math.min(w, h) * (s.roundrect_ratio ?? 0) : 0;
    g = radius ? roundedBoxRing(-w / 2 + radius, -h / 2 + radius, w / 2 - radius, h / 2 - radius, radius) : boxRing(-w / 2, -h / 2, w / 2, h / 2);
  }
  return rotateTranslate(g, -s.rotation, p.x, p.y);
}

export interface ResistanceGraph {
  edges: Edge[][];
  /** `via:i` / `pad:i` -> the graph nodes that touch it. */
  contacts: Map<string, Set<number>>;
  nodes: number;
}

export function resistanceGraph(tracks: readonly PathTrack[], vias: readonly PathVia[], pads: readonly PathPad[], copper: Readonly<Record<string, number>>, stack: readonly string[], opts: GraphOptions = {}): ResistanceGraph {
  const boardMm = opts.board_mm ?? 1.0, drillMm = opts.drill_mm ?? 0.2, platingMm = opts.plating_mm ?? 0.015;
  const edges: Edge[][] = [];
  const nodeMap = new Map<string, number>();
  const node = (pt: XY, layer: string) => {
    const key = `${pyRound(pt[0], 6)},${pyRound(pt[1], 6)},${layer}`;
    let id = nodeMap.get(key);
    if (id === undefined) {
      id = nodeMap.size;
      nodeMap.set(key, id);
    }
    return id;
  };
  const contacts = new Map<string, Set<number>>();
  const contact = (tag: string) => contacts.get(tag) ?? contacts.set(tag, new Set()).get(tag)!;
  const layerIndex = (l: string) => {
    const i = stack.indexOf(l);
    if (i < 0) throw new Error(`via layer ${l} is not in the board stack-up`);
    return i;
  };
  const span = (v: PathVia) => {
    const [lo, hi] = v.layers.map(layerIndex).sort((x, y) => x - y) as [number, number];
    return stack.slice(lo, hi + 1);
  };
  type Point = { pt: XY; layer: string; tag: string | null; radius: number; pad: number };
  const points: Point[] = [];
  for (const s of tracks) for (const p of [s.a, s.b]) points.push({ pt: p, layer: s.layer, tag: null, radius: 0.0, pad: -1 });
  vias.forEach((v, i) => {
    for (const layer of span(v)) points.push({ pt: [v.x, v.y], layer, tag: `via:${i}`, radius: v.size / 2, pad: -1 });
  });
  const padGeoms = new Map<number, Ring>();
  pads.forEach((p, i) => {
    const g = padRing(p);
    if (g) padGeoms.set(i, g);
    for (const layer of p.layers) points.push({ pt: [p.x, p.y], layer, tag: `pad:${i}`, radius: p.contact_r ?? 0.0, pad: i });
  });
  const link = (a: number, b: number, r: number, segment: number | null = null) => {
    if (a === b) return;
    (edges[a] ??= []).push([b, Math.max(r, 1e-12), segment]);
    (edges[b] ??= []).push([a, Math.max(r, 1e-12), segment]);
  };
  // Real copper may join at mid-segment crossings or by overlapping widths without coincident centreline endpoints:
  // keep the layer and pay a conservative lateral resistance through the overlap, never an unused via.
  const extraCuts: Array<Array<[number, number]>> = tracks.map(() => []);
  tracks.forEach((s, i) => {
    for (let j = 0; j < i; j++) {
      const o = tracks[j]!;
      if (s.layer !== o.layer) continue;
      const dist = segmentToSegment(s.a, s.b, o.a, o.b);
      const overlap = (s.w + o.w) / 2 - dist;
      if (overlap <= 1e-8) continue;
      const [a, b] = closestPoints(s.a, s.b, o.a, o.b);
      const na = node(a, s.layer), nb = node(b, s.layer);
      extraCuts[i]!.push([projectNormalized(s.a, s.b, a), na]);
      extraCuts[j]!.push([projectNormalized(o.a, o.b, b), nb]);
      link(na, nb, (RHO * dist) / (Math.min(s.w, o.w, overlap) * copper[s.layer]!));
    }
  });
  vias.forEach((v, i) => {
    for (const layer of span(v)) {
      const n = node([v.x, v.y], layer);
      contact(`via:${i}`).add(n);
      pads.forEach((p, j) => {
        if (!p.layers.includes(layer)) return;
        const geom = padGeoms.get(j);
        const hit = geom ? polygonPointDistance(geom, [v.x, v.y]) <= v.size / 2 + 1e-6 : mathDist([v.x, v.y], [p.x, p.y]) <= (p.contact_r ?? 0) + v.size / 2;
        if (hit) contact(`pad:${j}`).add(n);
      });
    }
  });
  tracks.forEach((s, k) => {
    const [ax, ay] = s.a, [bx, by] = s.b;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    if (l2 === 0) return;
    const cuts = new Map<number, number>([
      [0.0, node(s.a, s.layer)],
      [1.0, node(s.b, s.layer)],
    ]);
    for (const [u, n] of extraCuts[k]!) cuts.set(u, n);
    for (const { pt, layer, tag, radius, pad } of points) {
      if (layer !== s.layer) continue;
      let u = clamp01(((pt[0] - ax) * dx + (pt[1] - ay) * dy) / l2);
      let q: XY = [ax + u * dx, ay + u * dy];
      const tol = tag ? radius + s.w / 2 : 1e-5;
      const geom = pad >= 0 ? padGeoms.get(pad) : undefined;
      if (geom) {
        if (polygonSegmentDistance(geom, s.a, s.b) > s.w / 2 + 1e-6) continue;
        q = segmentPolygonNearest(s.a, s.b, geom);
        u = clamp01(((q[0] - ax) * dx + (q[1] - ay) * dy) / l2);
      } else if (mathDist(q, pt) > tol + 1e-6) continue;
      const n = node(q, layer);
      cuts.set(u, n);
      if (tag) contact(tag).add(n);
    }
    const ordered = [...cuts].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (let m = 0; m + 1 < ordered.length; m++) {
      const [u, a] = ordered[m]!, [v, b] = ordered[m + 1]!;
      link(a, b, (RHO * Math.sqrt(l2) * (v - u)) / (s.w * copper[s.layer]!), k);
    }
  });
  // via contacts keep their layers and pay a full-barrel conservative resistance
  const rv = (RHO * boardMm) / (Math.PI * drillMm * platingMm);
  vias.forEach((_, i) => {
    const vv = [...(contacts.get(`via:${i}`) ?? [])].sort((x, y) => x - y);
    for (const a of vv) for (const b of vv) if (a < b) link(a, b, rv);
  });
  // copper within a pad is a common terminal, not a guessed connection to another net
  pads.forEach((_, i) => {
    const pp = [...(contacts.get(`pad:${i}`) ?? [])].sort((x, y) => x - y);
    for (let m = 0; m + 1 < pp.length; m++) link(pp[m]!, pp[m + 1]!, 1e-9);
  });
  return { edges, contacts, nodes: nodeMap.size };
}

/** Min-heap of (distance, node), ordered like Python's tuples. */
class Heap {
  private a: Array<[number, number]> = [];
  private less = (x: [number, number], y: [number, number]) => x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  push(x: [number, number]) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i]!, a[p]!)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

export interface PathCensus {
  resistance_ohm: number;
  worst_terminal_pair: [number, number] | null;
  trunk_segments: number[];
  missing_terminals: number[];
  disconnected_terminal_pairs: Array<[number, number]>;
  model_nodes: number;
  terminal_count: number;
}

/** Worst track/via shortest-path resistance between every pair of terminals, with the coverage gaps named. */
export function pathCensus(tracks: readonly PathTrack[], vias: readonly PathVia[], pads: readonly PathPad[], copper: Readonly<Record<string, number>>, stack: readonly string[], terminalIds: readonly number[], opts: GraphOptions = {}): PathCensus {
  const { edges, contacts, nodes } = resistanceGraph(tracks, vias, pads, copper, stack, opts);
  const at = (i: number) => contacts.get(`pad:${i}`) ?? new Set<number>();
  const missing = terminalIds.filter((i) => !at(i).size);
  const reps = new Map<number, number>();
  for (const i of terminalIds) if (at(i).size) reps.set(i, Math.min(...at(i)));
  const disconnected: Array<[number, number]> = [];
  let worst = 0;
  let worstPair: [number, number] | null = null;
  const trunk = new Set<number>();
  for (const [i, src] of reps) {
    const distance = new Map<number, number>([[src, 0.0]]);
    const prev = new Map<number, [number, number | null]>();
    const todo = new Heap();
    todo.push([0.0, src]);
    for (let it = todo.pop(); it; it = todo.pop()) {
      const [d, a] = it;
      if (d > distance.get(a)!) continue;
      for (const [b, r, k] of edges[a] ?? []) {
        if (d + r < (distance.get(b) ?? Infinity)) {
          distance.set(b, d + r);
          prev.set(b, [a, k]);
          todo.push([d + r, b]);
        }
      }
    }
    for (const [j, dst] of reps) {
      if (i >= j) continue;
      if (!distance.has(dst)) {
        disconnected.push([i, j]);
        continue;
      }
      if (distance.get(dst)! > worst) {
        worst = distance.get(dst)!;
        worstPair = [i, j];
      }
      let x = dst;
      while (prev.has(x)) {
        const [px, k] = prev.get(x)!;
        x = px;
        if (k !== null) trunk.add(k);
      }
    }
  }
  return {
    resistance_ohm: worst,
    worst_terminal_pair: worstPair,
    trunk_segments: [...trunk].sort((x, y) => x - y),
    missing_terminals: missing,
    disconnected_terminal_pairs: disconnected,
    model_nodes: nodes,
    terminal_count: terminalIds.length,
  };
}
