/** Gerber objects as polygons in board coordinates (Y down: board y = -gerber y), for the silkscreen obstacle model. */
import { aperturePrims, type GerberFile, type ObjAttrs } from "../release/gerber";
import { circlePoly } from "./shapes";
import type { Poly, Pt } from "./geometry";

export interface GShape {
  attrs: ObjAttrs;
  /** Aperture function for flashes (ViaPad, SMDPad ...). */
  fn?: string;
  poly: Poly;
}

function capsule(a: Pt, b: Pt, r: number): Poly {
  const th = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const n = 8;
  const out: Poly = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + r * Math.cos(th + Math.PI / 2 + (Math.PI * i) / n), a[1] + r * Math.sin(th + Math.PI / 2 + (Math.PI * i) / n)]);
  for (let i = 0; i <= n; i++) out.push([b[0] + r * Math.cos(th - Math.PI / 2 + (Math.PI * i) / n), b[1] + r * Math.sin(th - Math.PI / 2 + (Math.PI * i) / n)]);
  return out;
}

function arcChords(a: Pt, b: Pt, c: Pt, cw: boolean, tol = 0.01): Pt[] {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const ta = Math.atan2(a[1] - c[1], a[0] - c[0]);
  const tb = Math.atan2(b[1] - c[1], b[0] - c[0]);
  const T = 2 * Math.PI;
  let sweep = cw ? ta - tb : tb - ta;
  sweep = ((sweep % T) + T) % T;
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) sweep = T;
  const step = 2 * Math.acos(Math.max(0, 1 - tol / Math.max(r, tol)));
  const n = Math.max(2, Math.ceil(sweep / Math.max(step, 0.05)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push([c[0] + r * Math.cos(ta + (cw ? -1 : 1) * (sweep * i) / n), c[1] + r * Math.sin(ta + (cw ? -1 : 1) * (sweep * i) / n)]);
  return out;
}

const flip = (p: Pt): Pt => [p[0], -p[1]];

/** Dark (positive) objects of the file as polygons; clear polarity objects are not subtracted (KiCad's mask and silk layers use none). */
export function gerberShapes(g: GerberFile): GShape[] {
  const unit = g.unit === "in" ? 25.4 : 1;
  const prims = new Map<number, ReturnType<typeof aperturePrims>>();
  const out: GShape[] = [];
  for (const o of g.objects) {
    if (!o.dark) continue;
    if (o.kind === "flash") {
      let ps = prims.get(o.ap);
      if (!ps) prims.set(o.ap, (ps = aperturePrims(g.apertures.get(o.ap) ?? { code: o.ap, kind: "C", params: [0] }, g.macros, unit)));
      const fn = g.apertures.get(o.ap)?.fn;
      for (const q of ps) {
        let poly: Poly;
        if (q.t === "circle") poly = circlePoly([o.x + q.cx, o.y + q.cy], q.r, Math.max(12, Math.min(32, Math.ceil(q.r * 40))));
        else if (q.t === "poly") poly = q.pts.map(([x, y]) => [o.x + x, o.y + y] as Pt);
        else {
          const r = Math.min(q.w, q.h) / 2;
          const horizontal = q.w >= q.h;
          const half = (horizontal ? q.w : q.h) / 2 - r;
          poly = horizontal ? capsule([o.x - half, o.y], [o.x + half, o.y], r) : capsule([o.x, o.y - half], [o.x, o.y + half], r);
        }
        out.push({ attrs: o.attrs, ...(fn ? { fn } : {}), poly: poly.map(flip) });
      }
    } else if (o.kind === "draw") {
      const w = ((g.apertures.get(o.ap)?.params[0] ?? 0) * unit) / 2;
      if (o.arc) {
        const pts = arcChords(o.a, o.b, [o.arc.cx, o.arc.cy], o.arc.cw);
        for (let i = 0; i + 1 < pts.length; i++) out.push({ attrs: o.attrs, poly: capsule(pts[i]!, pts[i + 1]!, w).map(flip) });
      } else out.push({ attrs: o.attrs, poly: capsule(o.a, o.b, w).map(flip) });
    } else {
      const pts: Pt[] = [o.start];
      let prev = o.start;
      for (const s of o.segs) {
        if ("cx" in s) pts.push(...arcChords(prev, [s.x, s.y], [s.cx, s.cy], s.cw).slice(1));
        else pts.push([s.x, s.y]);
        prev = [s.x, s.y];
      }
      out.push({ attrs: o.attrs, poly: pts.map(flip) });
    }
  }
  return out;
}
