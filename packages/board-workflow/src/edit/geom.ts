/** Placement geometry for the edit stage (the toolkit's `tp_legalise` + the geometry half of `edit_move`). */
import { topLevelSpans, kid, kids, num, type SNode } from "../sexpr";
import { mod, round } from "./fmt";

export type Box = [number, number, number, number];
export type Pt = [number, number];

export function rotPt(px: number, py: number, rot: number): Pt {
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  return [px * c + py * s, -px * s + py * c];
}

export function fpRot(fp: SNode): number {
  const tr = kid(fp, "transform");
  const rt = tr && kid(tr, "rotate");
  if (rt) return num(rt[1]);
  const at = kid(fp, "at");
  return at && at.length > 3 ? num(at[3]) : 0;
}

/** Courtyard box in footprint coordinates; falls back to the pads plus 0.25 mm; nothing at all -> zero box. */
export function localBox(fp: SNode): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of fp) {
    if (!Array.isArray(g) || !["fp_line", "fp_rect", "fp_poly", "fp_circle"].includes(g[0] as string)) continue;
    const layer = kid(g, "layer");
    if (!layer || !String(layer[1]).includes("CrtYd")) continue;
    if (g[0] === "fp_circle") {
      const c = kid(g, "center")!;
      const e = kid(g, "end")!;
      const rr = Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2]));
      xs.push(num(c[1]) - rr, num(c[1]) + rr);
      ys.push(num(c[2]) - rr, num(c[2]) + rr);
      continue;
    }
    for (const k of ["start", "end"]) {
      const p = kid(g, k);
      if (p) {
        xs.push(num(p[1]));
        ys.push(num(p[2]));
      }
    }
    const pts = kid(g, "pts");
    for (const xy of pts ? kids(pts, "xy") : []) {
      xs.push(num(xy[1]));
      ys.push(num(xy[2]));
    }
  }
  if (!xs.length)
    for (const pad of kids(fp, "pad")) {
      const at = kid(pad, "at")!;
      const size = kid(pad, "size")!;
      const w = num(size[1]) / 2 + 0.25;
      const h = num(size[2]) / 2 + 0.25;
      xs.push(num(at[1]) - w, num(at[1]) + w);
      ys.push(num(at[2]) - h, num(at[2]) + h);
    }
  if (!xs.length) return [0, 0, 0, 0];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function worldBox(box: Box, x: number, y: number, rot: number): Box {
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const pts: Pt[] = [];
  for (const px of [box[0], box[2]]) for (const py of [box[1], box[3]]) pts.push([x + px * c + py * s, y - px * s + py * c]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

export const overlap = (a: Box, b: Box, gap: number): boolean => a[0] < b[2] + gap && b[0] < a[2] + gap && a[1] < b[3] + gap && b[1] < a[3] + gap;

export interface PadGeo {
  name: string;
  net: string;
  box: Box;
  drilled: boolean;
  layers: Set<string>;
}

/** Pads of the footprint `fp` as if it sat at (x, y, rot), boxes grown by `grow`. File angles are absolute (they include the footprint's own). */
export function padList(fp: SNode, x: number, y: number, rot: number, grow = 0): PadGeo[] {
  const out: PadGeo[] = [];
  const base = fpRot(fp);
  for (const pad of kids(fp, "pad")) {
    const at = kid(pad, "at")!;
    const size = kid(pad, "size");
    const net = kid(pad, "net");
    const [dx, dy] = rotPt(num(at[1]), num(at[2]), rot);
    const cx = x + dx;
    const cy = y + dy;
    let w = size ? num(size[1]) : 0.6;
    let h = size ? num(size[2]) : 0.6;
    const pa = (at.length > 3 ? num(at[3]) : 0) + rot - base;
    if (round(mod(pa, 180), 0) === 90) [w, h] = [h, w];
    const hw = w / 2 + grow;
    const hh = h / 2 + grow;
    const lay = (kid(pad, "layers") ?? ["layers"]).slice(1) as string[];
    out.push({
      name: String(pad[1]),
      net: net ? String(net[net.length - 1]) : "",
      box: [cx - hw, cy - hh, cx + hw, cy + hh],
      drilled: !!kid(pad, "drill"),
      layers: new Set(lay.filter((l) => l.endsWith(".Cu") || l.startsWith("*"))),
    });
  }
  return out;
}

/** Liang-Barsky: does the segment a-b (half width `hw`) touch the box grown by `hw`? */
export function segBoxHit(a: Pt, b: Pt, hw: number, box: Box): boolean {
  const x0 = box[0] - hw, y0 = box[1] - hw, x1 = box[2] + hw, y1 = box[3] + hw;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as Array<[number, number]>) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export interface RoutedItem {
  kind: "segment" | "via" | "arc";
  start: number;
  end: number;
  net: string;
  pts: Pt[];
  hw: number;
  layers: Set<string>;
}

const ITEM_NET = /\(net "([^"]*)"\)/;
export const PTS = /\((start|end|at|mid) ([-\d.]+) ([-\d.]+)/g;

/** Every routed item in board text, in file order per kind (segments, vias, arcs). */
export function routedItems(text: string): RoutedItem[] {
  const out: RoutedItem[] = [];
  for (const kind of ["segment", "via", "arc"] as const) {
    for (const { start, end } of topLevelSpans(text, kind)) {
      const it = text.slice(start, end);
      const net = ITEM_NET.exec(it)?.[1] ?? "";
      const pts: Pt[] = [...it.matchAll(PTS)].map((m) => [Number(m[2]), Number(m[3])]);
      let hw: number;
      let layers: Set<string>;
      if (kind === "via") {
        const sz = /\(size ([-\d.]+)/.exec(it);
        hw = sz ? Number(sz[1]) / 2 : 0.25;
        layers = new Set(["*"]);
      } else {
        const w = /\(width ([-\d.]+)\)/.exec(it);
        hw = w ? Number(w[1]) / 2 : 0.075;
        layers = new Set([/\(layer "([^"]+)"\)/.exec(it)![1]!]);
      }
      out.push({ kind, start, end, net, pts, hw, layers });
    }
  }
  return out;
}

export function itemHitsBox(it: RoutedItem, box: Box): boolean {
  const { kind, pts, hw } = it;
  if (kind === "via") {
    const [x, y] = pts[0]!;
    return box[0] - hw <= x && x <= box[2] + hw && box[1] - hw <= y && y <= box[3] + hw;
  }
  if (kind === "arc" && pts.length === 3) return segBoxHit(pts[0]!, pts[1]!, hw, box) || segBoxHit(pts[1]!, pts[2]!, hw, box);
  return segBoxHit(pts[0]!, pts[pts.length - 1]!, hw, box);
}

export function onLayers(it: RoutedItem, padLayers: Set<string>, side: string): boolean {
  if (it.layers.has("*")) return true;
  const lay = [...it.layers][0]!;
  if ([...padLayers].some((l) => l.startsWith("*"))) return true;
  return padLayers.has(lay) || (lay === `${side}.Cu` && padLayers.size === 0);
}

/** Apply fx to every point of a routed item's text. */
export function transformItem(body: string, fx: (x: number, y: number) => Pt): string {
  return body.replace(/\((start|end|at|mid) ([-\d.]+) ([-\d.]+)/g, (_m, k: string, x: string, y: string) => {
    const [nx, ny] = fx(Number(x), Number(y));
    return `(${k} ${round(nx, 4).toFixed(4)} ${round(ny, 4).toFixed(4)}`;
  });
}
