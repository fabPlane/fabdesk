/** Board-file shapes (courtyards, assembly outlines, the board outline) as polygons in board coordinates, mm. */
import { kid, kids, num, type SNode } from "../sexpr";
import type { Poly, Pt, Rect } from "./geometry";

export interface FpPlacement {
  x: number;
  y: number;
  /** Degrees. */
  rot: number;
}

/** A footprint-local point to board coordinates (KiCad: rotation counter-clockwise on screen, Y down). */
export function toBoard(p: FpPlacement, x: number, y: number): Pt {
  const a = p.rot * (Math.PI / 180);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p.x + x * c + y * s, p.y - x * s + y * c];
}

const pt = (n: SNode | undefined): Pt => [num(n?.[1]), num(n?.[2])];

export function strokeWidth(g: SNode): number {
  const st = kid(g, "stroke");
  const w = st ? kid(st, "width") : kid(g, "width");
  return num(w?.[1]);
}

/** Points along the arc through start, mid, end (chord error <= tol). */
export function arcPoints(a: Pt, m: Pt, b: Pt, tol = 0.01): Pt[] {
  const [x1, y1] = a;
  const [x2, y2] = m;
  const [x3, y3] = b;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) return [a, b];
  const ux = ((x1 ** 2 + y1 ** 2) * (y2 - y3) + (x2 ** 2 + y2 ** 2) * (y3 - y1) + (x3 ** 2 + y3 ** 2) * (y1 - y2)) / d;
  const uy = ((x1 ** 2 + y1 ** 2) * (x3 - x2) + (x2 ** 2 + y2 ** 2) * (x1 - x3) + (x3 ** 2 + y3 ** 2) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const T = 2 * Math.PI;
  const mod = (v: number) => ((v % T) + T) % T;
  const a1 = Math.atan2(y1 - uy, x1 - ux);
  const a2 = Math.atan2(y2 - uy, x2 - ux);
  const a3 = Math.atan2(y3 - uy, x3 - ux);
  const ccw = mod(a2 - a1) < mod(a3 - a1);
  const sweep = ccw ? mod(a3 - a1) : -mod(a1 - a3);
  const step = 2 * Math.acos(Math.max(0, 1 - tol / Math.max(r, tol)));
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 0.05)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push([ux + r * Math.cos(a1 + (sweep * i) / n), uy + r * Math.sin(a1 + (sweep * i) / n)]);
  out[0] = a;
  out[n] = b;
  return out;
}

export function circlePoly(c: Pt, r: number, n = 32): Poly {
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as Pt);
}

export type Shape = { type: "line" | "arc" | "rect" | "circle" | "poly"; pts: Pt[]; closed: boolean; width: number };

/** Shapes of one kind of graphic on `layer` in a footprint or board node, as local point lists. */
export function shapesOn(node: SNode, layer: string, prefix: "fp_" | "gr_"): Shape[] {
  const out: Shape[] = [];
  for (const g of node) {
    if (!Array.isArray(g) || typeof g[0] !== "string" || !g[0].startsWith(prefix)) continue;
    if (kid(g, "layer")?.[1] !== layer) continue;
    const kind = g[0].slice(prefix.length);
    const width = strokeWidth(g);
    if (kind === "line") out.push({ type: "line", pts: [pt(kid(g, "start")), pt(kid(g, "end"))], closed: false, width });
    else if (kind === "arc") out.push({ type: "arc", pts: arcPoints(pt(kid(g, "start")), pt(kid(g, "mid")), pt(kid(g, "end"))), closed: false, width });
    else if (kind === "rect") {
      const [a, b] = [pt(kid(g, "start")), pt(kid(g, "end"))];
      out.push({ type: "rect", pts: [a, [b[0], a[1]], b, [a[0], b[1]]], closed: true, width });
    } else if (kind === "circle") {
      const c = pt(kid(g, "center"));
      const e = pt(kid(g, "end"));
      out.push({ type: "circle", pts: circlePoly(c, Math.hypot(e[0] - c[0], e[1] - c[1])), closed: true, width });
    } else if (kind === "poly") {
      const pts = kids(kid(g, "pts") ?? [], "xy").map(pt);
      if (pts.length) out.push({ type: "poly", pts, closed: true, width });
    } else if (kind === "curve") {
      const pts = kids(kid(g, "pts") ?? [], "xy").map(pt);
      if (pts.length) out.push({ type: "poly", pts, closed: false, width });
    }
  }
  return out;
}

/**
 * Closed outlines from a set of shapes: closed shapes as they are, open ones (lines, arcs) chained by their endpoints
 * (within `tol` mm) into loops. Open chains that do not close are dropped.
 */
export function loops(shapes: Shape[], tol = 0.02): Poly[] {
  const out: Poly[] = shapes.filter((s) => s.closed && s.pts.length >= 3).map((s) => s.pts);
  const open = shapes.filter((s) => !s.closed && s.pts.length >= 2).map((s) => s.pts.map((p) => [...p] as Pt));
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  while (open.length) {
    let chain = open.pop()!;
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const s = open[i]!;
        const head = chain[0]!;
        const tail = chain[chain.length - 1]!;
        let next: Pt[] | null = null;
        if (near(tail, s[0]!)) next = [...chain, ...s.slice(1)];
        else if (near(tail, s[s.length - 1]!)) next = [...chain, ...[...s].reverse().slice(1)];
        else if (near(head, s[s.length - 1]!)) next = [...s, ...chain.slice(1)];
        else if (near(head, s[0]!)) next = [...[...s].reverse(), ...chain.slice(1)];
        if (next) {
          chain = next;
          open.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (chain.length >= 4 && near(chain[0]!, chain[chain.length - 1]!)) out.push(chain.slice(0, -1));
  }
  return out;
}

export const polyArea = (p: Poly): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!;
    const [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

export const boxOfPoints = (pts: Pt[], pad = 0): Rect => [Math.min(...pts.map((p) => p[0])) - pad, Math.min(...pts.map((p) => p[1])) - pad, Math.max(...pts.map((p) => p[0])) + pad, Math.max(...pts.map((p) => p[1])) + pad];
