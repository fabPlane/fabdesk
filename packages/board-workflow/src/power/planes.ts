/**
 * A split power plane on one inner layer from a plan of nets (port of the toolkit's `tools/power_planes.py`).
 *
 * Each grid cell inside the board (`edge_mm` in from the outline box) goes to the plan net whose pad is nearest,
 * distance divided by weight, if within `reach_mm`. A net whose area falls into pieces is joined by straight corridors
 * (`corridor_mm` wide) along a minimum spanning tree of its pieces, so each plane area is one piece. Where two plan nets
 * meet, the cells on both sides are left out (the fill net takes them) so fills keep clearance at staircase corners;
 * `keepout_circles` (outline notches) are left out too. Each net becomes one zone of row rectangles (overlapping by
 * 0.01 mm so KiCad unions them); priorities follow the plan order, `fill_net` (one zone over the whole box) lowest.
 * Zones named in `remove_zone_names` (stale local zones from an earlier placement) are dropped first. The agent picks
 * nets, weights and reach; this computes the outlines. KiCad's fill keeps every clearance.
 *
 * Differences from the script: the grid box is the board's Edge.Cuts bounding box (the script had C6's 74.9 x 65.4 mm
 * outline written in) unless the plan gives `box`, and zone names start with `name_prefix` (the script wrote "C6").
 */
import { randomUUID } from "node:crypto";
import { pyRound } from "../accept";
import { parseBoard } from "../board";
import { appendBeforeClose } from "../layout/text";
import { quote, removeSpans, topLevelSpans } from "../sexpr";

export interface PlanesPlan {
  note?: string;
  /** The inner copper layer, e.g. "In4.Cu". */
  layer: string;
  cell_mm?: number;
  edge_mm?: number;
  reach_mm?: number;
  clearance_mm?: number;
  corridor_mm?: number;
  remove_zone_names?: string[];
  fill_net?: string;
  keepout_circles?: Array<[number, number, number]>;
  nets: Array<{ net: string; weight?: number }>;
  /** Grid box X0, Y0, X1, Y1 before `edge_mm` (default: the board outline's bounding box). */
  box?: [number, number, number, number];
  /** Zone names start with this (default "power_planes"; the script wrote "C6"). */
  name_prefix?: string;
}

export interface PlanesRecord {
  layer: string;
  zones: number;
  corridors: number;
  nets: Record<string, { area_mm2: number; rects: number; pieces: number }>;
  removed_zones: string[];
  /** The grid box the cells cover, after `edge_mm`. */
  box: [number, number, number, number];
}

export class PlanesError extends Error {}

/** Validate a plan read from JSON (what a caller hands in is untrusted). */
export function checkPlanesPlan(x: unknown): PlanesPlan {
  const p = x as PlanesPlan;
  const bad = (why: string) => new PlanesError(`power planes plan: ${why}`);
  if (!p || typeof p !== "object") throw bad("not a JSON object");
  if (typeof p.layer !== "string" || !/^In\d+\.Cu$/.test(p.layer)) throw bad(`layer must be an inner copper layer such as "In4.Cu" (got ${JSON.stringify(p.layer)})`);
  if (!Array.isArray(p.nets) || !p.nets.length || p.nets.some((n) => !n || typeof n.net !== "string" || (n.weight !== undefined && !(typeof n.weight === "number" && n.weight > 0))))
    throw bad('nets must be a non-empty list of {"net": NAME, "weight": >0}');
  for (const k of ["cell_mm", "edge_mm", "reach_mm", "clearance_mm", "corridor_mm"] as const)
    if (p[k] !== undefined && !(typeof p[k] === "number" && Number.isFinite(p[k]) && p[k]! >= 0)) throw bad(`${k} must be a number >= 0`);
  if (p.cell_mm !== undefined && p.cell_mm < 0.05) throw bad("cell_mm must be at least 0.05");
  if (p.box !== undefined && !(Array.isArray(p.box) && p.box.length === 4 && p.box.every((v) => typeof v === "number" && Number.isFinite(v)))) throw bad("box is [X0, Y0, X1, Y1]");
  if (p.keepout_circles !== undefined && !(Array.isArray(p.keepout_circles) && p.keepout_circles.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === "number"))))
    throw bad("keepout_circles is a list of [x, y, r]");
  if (p.remove_zone_names !== undefined && !(Array.isArray(p.remove_zone_names) && p.remove_zone_names.every((n) => typeof n === "string"))) throw bad("remove_zone_names is a list of names");
  if (p.fill_net !== undefined && typeof p.fill_net !== "string") throw bad("fill_net is a net name");
  return p;
}

/** Row runs merged downward into rectangles (x0, y0, x1, y1). */
export function rects(mask: Uint8Array, nx: number, ny: number, x0: number, y0: number, c: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const open = new Map<string, number>();
  for (let j = 0; j <= ny; j++) {
    const runs: Array<[number, number]> = [];
    if (j < ny) {
      let i = 0;
      while (i < nx) {
        if (mask[j * nx + i]) {
          let k = i;
          while (k < nx && mask[j * nx + k]) k++;
          runs.push([i, k]);
          i = k;
        } else i++;
      }
    }
    const keys = new Set(runs.map(([a, b]) => `${a},${b}`));
    for (const [key, start] of [...open]) {
      if (keys.has(key)) continue;
      const [a, b] = key.split(",").map(Number) as [number, number];
      out.push([x0 + a * c, y0 + start * c, x0 + b * c, y0 + j * c]);
      open.delete(key);
    }
    for (const key of keys) if (!open.has(key)) open.set(key, j);
  }
  return out;
}

/** 4-connected components of `mask`, labelled 1.. in raster order of their first cell (scipy.ndimage.label). */
export function label(mask: Uint8Array, nx: number, ny: number): { lab: Int32Array; n: number } {
  const lab = new Int32Array(nx * ny);
  let n = 0;
  const stack: number[] = [];
  for (let s = 0; s < nx * ny; s++) {
    if (!mask[s] || lab[s]) continue;
    lab[s] = ++n;
    stack.push(s);
    while (stack.length) {
      const q = stack.pop()!;
      const j = Math.trunc(q / nx), i = q - j * nx;
      const nb = [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, j > 0 ? q - nx : -1, j < ny - 1 ? q + nx : -1];
      for (const r of nb) if (r >= 0 && mask[r] && !lab[r]) (lab[r] = n), stack.push(r);
    }
  }
  return { lab, n };
}

/**
 * Minimum spanning tree of a dense symmetric distance matrix (scipy.sparse.csgraph.minimum_spanning_tree: Kruskal over
 * the non-zero entries in row-major order, stably sorted by weight), as [a, b] edges.
 */
export function mst(D: number[][]): Array<[number, number]> {
  const m = D.length;
  const edges: Array<[number, number, number]> = [];
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) if (D[a]![b]) edges.push([a, b, D[a]![b]!]);
  const order = edges.map((_, i) => i).sort((x, y) => edges[x]![2] - edges[y]![2] || x - y);
  const parent = Array.from({ length: m }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const out: Array<[number, number]> = [];
  for (const k of order) {
    if (out.length >= m - 1) break;
    const [a, b] = edges[k]!;
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    parent[ra] = rb;
    out.push([a, b]);
  }
  return out;
}

/** Generate the plane zones; returns the board text with them added (and the named zones removed). */
export function powerPlanes(text: string, plan0: PlanesPlan, o: { uuid?: () => string } = {}): { text: string; record: PlanesRecord } {
  const plan = checkPlanesPlan(plan0);
  const uuid = o.uuid ?? randomUUID;
  for (const name of plan.remove_zone_names ?? []) {
    const spans = topLevelSpans(text, "zone").filter((s) => text.slice(s.start, s.end).includes(`(name ${quote(name)})`));
    if (!spans.length) throw new PlanesError(`no zone named ${JSON.stringify(name)}`);
    text = removeSpans(text, spans);
  }
  const board = parseBoard(text);
  const c = plan.cell_mm ?? 0.5, edge = plan.edge_mm ?? 0.5, reach = plan.reach_mm ?? 8.0;
  const ob = plan.box ?? (board.outline ? [board.outline.minX, board.outline.minY, board.outline.maxX, board.outline.maxY] : null);
  if (!ob) throw new PlanesError("the board has no Edge.Cuts outline: give the plan a box [X0, Y0, X1, Y1]");
  const X0 = ob[0] + edge, Y0 = ob[1] + edge, X1 = ob[2] - edge, Y1 = ob[3] - edge;
  const nx = Math.trunc((X1 - X0) / c), ny = Math.trunc((Y1 - Y0) / c);
  if (nx <= 0 || ny <= 0) throw new PlanesError(`the grid box ${[X0, Y0, X1, Y1].join(", ")} holds no ${c} mm cell`);
  if (nx * ny > 16_000_000) throw new PlanesError(`${nx} x ${ny} cells: use a larger cell_mm`);
  const gx = Float64Array.from({ length: nx }, (_, i) => X0 + (i + 0.5) * c);
  const gy = Float64Array.from({ length: ny }, (_, j) => Y0 + (j + 0.5) * c);
  const N = nx * ny;
  const best = new Float64Array(N).fill(Infinity);
  const owner = new Int32Array(N).fill(-1);
  const nets = plan.nets;
  const d = new Float64Array(N);
  for (const [k, n] of nets.entries()) {
    const pts = board.pads.filter((p) => p.net === n.net);
    if (!pts.length) throw new PlanesError(`net ${n.net} has no pads`);
    const w = n.weight ?? 1.0;
    d.fill(Infinity);
    // only cells within reach of a pad can be taken (d * w <= reach), so each pad scans its reach window (plus a cell)
    const span = reach + c;
    for (const p of pts)
      for (let j = Math.max(0, Math.floor((p.y - span - Y0) / c)); j < Math.min(ny, Math.ceil((p.y + span - Y0) / c) + 1); j++)
        for (let i = Math.max(0, Math.floor((p.x - span - X0) / c)); i < Math.min(nx, Math.ceil((p.x + span - X0) / c) + 1); i++) {
          const h = Math.hypot(gx[i]! - p.x, gy[j]! - p.y);
          if (h < d[j * nx + i]!) d[j * nx + i] = h;
        }
    for (let s = 0; s < N; s++) {
      const dd = d[s]! / w;
      if (dd < best[s]! && dd * w <= reach) (best[s] = dd), (owner[s] = k);
    }
  }
  // join each net's separate pieces with straight corridors along a minimum spanning tree, so every plane area is one
  // piece (a net whose pads are far apart otherwise gets islands); higher-priority corridors drawn last win crossings
  const half = (plan.corridor_mm ?? 2.0) / 2;
  let corridors = 0;
  const maskOf = (k: number) => {
    const m = new Uint8Array(N);
    for (let s = 0; s < N; s++) if (owner[s] === k) m[s] = 1;
    return m;
  };
  for (let k = nets.length - 1; k >= 0; k--) {
    const { lab, n: m } = label(maskOf(k), nx, ny);
    if (m < 2) continue;
    const cells: Array<Array<[number, number]>> = Array.from({ length: m }, () => []);
    for (let s = 0; s < N; s++) if (lab[s]) cells[lab[s]! - 1]!.push([Math.trunc(s / nx), s % nx]);
    // thinned out for the pair search
    const sub = cells.map((cs) => cs.filter((_, idx) => idx % Math.max(1, Math.trunc(cs.length / 60)) === 0));
    const D: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const P = new Map<string, [[number, number], [number, number]]>();
    for (let a = 0; a < m; a++)
      for (let b = a + 1; b < m; b++) {
        let bestD = Infinity, bi = 0, bj = 0;
        const A = sub[a]!, B = sub[b]!;
        for (let i = 0; i < A.length; i++)
          for (let j = 0; j < B.length; j++) {
            const dd = (A[i]![0] - B[j]![0]) ** 2 + (A[i]![1] - B[j]![1]) ** 2;
            if (dd < bestD) (bestD = dd), (bi = i), (bj = j);
          }
        D[a]![b] = D[b]![a] = Math.sqrt(bestD) + 1e-6;
        P.set(`${a},${b}`, [A[bi]!, B[bj]!]);
      }
    for (const [a, b] of mst(D)) {
      const [[j0, i0], [j1, i1]] = P.get(`${Math.min(a, b)},${Math.max(a, b)}`)!;
      const x0 = gx[i0]!, y0 = gy[j0]!, x1 = gx[i1]!, y1 = gy[j1]!;
      const L = Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-9);
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const X = gx[i]!, Y = gy[j]!;
          const t = Math.min(1, Math.max(0, ((X - x0) * (x1 - x0) + (Y - y0) * (y1 - y0)) / L ** 2));
          if (Math.hypot(X - (x0 + t * (x1 - x0)), Y - (y0 + t * (y1 - y0))) <= half) owner[j * nx + i] = k;
        }
      corridors++;
    }
  }
  // one-cell gap where two plan nets meet (the fill net takes it), so fills keep clearance at staircase corners
  const border = new Uint8Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const o0 = owner[j * nx + i]!;
      if (o0 < 0) continue;
      for (let dj = -1; dj <= 1 && !border[j * nx + i]; dj++)
        for (let di = -1; di <= 1; di++) {
          const jj = j + dj, ii = i + di;
          if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) continue;
          const nb = owner[jj * nx + ii]!;
          if (nb >= 0 && nb !== o0) {
            border[j * nx + i] = 1;
            break;
          }
        }
    }
  for (let s = 0; s < N; s++) if (border[s]) owner[s] = -1;
  for (const [cx, cy, r] of plan.keepout_circles ?? []) // outline notches
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (Math.hypot(gx[i]! - cx, gy[j]! - cy) <= r) owner[j * nx + i] = -1;
  const zones: string[] = [];
  const stats: PlanesRecord["nets"] = {};
  const top = nets.length + 1;
  const clearance = plan.clearance_mm ?? 0.2;
  const prefix = plan.name_prefix ?? "power_planes";
  for (const [k, n] of nets.entries()) {
    const m = maskOf(k);
    const boxes = rects(m, nx, ny, X0, Y0, c);
    let cnt = 0;
    for (let s = 0; s < N; s++) cnt += m[s]!;
    stats[n.net] = { area_mm2: pyRound(cnt * c * c, 1), rects: boxes.length, pieces: label(m, nx, ny).n };
    if (boxes.length) zones.push(zone(n.net, plan.layer, top - k, boxes, clearance, `${prefix} ${plan.layer} power plane ${n.net}`, uuid()));
  }
  if (plan.fill_net) zones.push(zone(plan.fill_net, plan.layer, 0, [[X0, Y0, X1, Y1]], clearance, `${prefix} ${plan.layer} ${plan.fill_net} fill`, uuid()));
  const out = zones.length ? appendBeforeClose(text, zones.join("")) : text;
  return { text: out, record: { layer: plan.layer, zones: zones.length, corridors, nets: stats, removed_zones: plan.remove_zone_names ?? [], box: [X0, Y0, X1, Y1] } };
}

function zone(net: string, layer: string, prio: number, boxes: Array<[number, number, number, number]>, clearance: number, name: string, id: string): string {
  const e = 0.01;
  const f3 = (x: number) => pyRound(x, 3).toFixed(3);
  const polys = boxes
    .map(([a, b, c, d]) => `\n    (polygon (pts (xy ${f3(a - e)} ${f3(b - e)}) (xy ${f3(c + e)} ${f3(b - e)}) (xy ${f3(c + e)} ${f3(d + e)}) (xy ${f3(a - e)} ${f3(d + e)})))`)
    .join("");
  return (
    `\n  (zone (net ${quote(net)}) (layer ${quote(layer)}) (uuid "${id}") (name ${quote(name)}) (hatch edge 0.5) (priority ${prio})` +
    `\n    (connect_pads yes (clearance ${clearance})) (min_thickness 0.15)` +
    `\n    (fill yes (thermal_gap 0.25) (thermal_bridge_width 0.3) (island_removal_mode 1) (island_area_min 0.5))${polys})`
  );
}
