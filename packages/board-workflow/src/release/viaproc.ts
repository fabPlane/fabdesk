/**
 * Via manufacturing bindings: classify every via against exact pad copper, find the ones that need fill and cap.
 *
 * A via whose drill hole meets the copper of an SMD pad (any net) is via-in-pad: solder wicks through an open hole, so it
 * must be filled and copper-capped (IPC-4761 Type VII). Laser microvias always need fill + cap. Other through vias need
 * nothing. Pad copper is exact for supported rect / roundrect / oval / circle shapes (absolute pad angles, KiCad 9+);
 * chamfered pads refuse classification until their native geometry can be verified. Custom pads use supported exact
 * circle/line/polygon/rectangle primitives; unsupported primitives refuse classification. `applyViaBindings` writes
 * `(capping yes) (filling yes)` on every via that needs them (an attribute
 * only: no geometry changes).
 */
import { kid, kids, num, parseSexpr, topLevelSpans as sexprTopLevelSpans, type SNode } from "../sexpr";

interface SmdPad {
  ref: string;
  pad: string;
  net: string;
  x: number;
  y: number;
  ang: number;
  w: number;
  h: number;
  shape: string;
  layers: Set<string>;
  radiusRatio?: number;
  primitives?: SNode[];
  anchor?: string;
  chamfered?: boolean;
}

export interface ViaClass {
  uuid: string | null;
  xy: [number, number];
  net: string;
  type: "micro" | "blind" | "through";
  span: string[];
  diameter_mm: number;
  drill_mm: number;
  in_component_lands: string[];
  required_filling: boolean;
  required_copper_capping: boolean;
  native_filling: boolean;
  native_capping: boolean;
  /** Offsets of the via's block in the file text (not part of the bindings file). */
  span_: [number, number];
}

export interface ViaBindings {
  schema: "FLOW_VIA_PROCESS_BINDINGS_V1";
  board: string;
  rule: string;
  counts: { vias: number; through: number; micro: number; via_in_pad: number; require_fill_cap: number; missing_native_before: number; filled_not_required: number };
  bindings: Array<Omit<ViaClass, "span_">>;
}

function smdPads(root: SNode): SmdPad[] {
  const out: SmdPad[] = [];
  for (const fp of kids(root, "footprint")) {
    const tr = kid(fp, "transform");
    let x: number, y: number, rot: number;
    if (tr) {
      const t = kid(tr, "translate");
      [x, y] = [num(t?.[1]), num(t?.[2])];
      rot = kid(tr, "rotate") ? num(kid(tr, "rotate")![1]) : 0;
    } else {
      const at = kid(fp, "at");
      [x, y, rot] = [num(at?.[1]), num(at?.[2]), at && at.length > 3 ? num(at[3]) : 0];
    }
    const ref = kids(fp, "property").find((p) => p[1] === "Reference")?.[2];
    const c = Math.cos(rot * (Math.PI / 180));
    const s = Math.sin(rot * (Math.PI / 180));
    for (const pad of kids(fp, "pad")) {
      if (pad.length < 3 || pad[2] !== "smd") continue;
      const at = kid(pad, "at");
      const px = num(at?.[1]);
      const py = num(at?.[2]);
      const pang = at && at.length > 3 ? num(at[3]) : 0; // absolute pad angle
      const size = kid(pad, "size");
      let w = num(size?.[1]);
      let h = num(size?.[2]);
      const shape = String(pad[3] ?? "rect");
      const primitives = kid(pad, "primitives");
      const ratio = kid(pad,"roundrect_rratio");
      const anchor = kid(kid(pad,"options") ?? [],"anchor");
      const chamfered = num(kid(pad, "chamfer_ratio")?.[1]) > 0 && (kid(pad, "chamfer")?.length ?? 0) > 1;
      const layers = new Set((kid(pad, "layers") ?? []).slice(1).filter((l): l is string => typeof l === "string" && l.endsWith(".Cu")));
      const net = kid(pad, "net");
      out.push({ ref: String(ref ?? ""), pad: String(pad[1]), net: net ? String(net[net.length - 1]) : "", x: x + px * c + py * s, y: y - px * s + py * c, ang: pang, w, h, shape, layers, ...(ratio ? { radiusRatio: num(ratio[1]) } : {}), ...(primitives ? { primitives: primitives.slice(1).filter(Array.isArray) as SNode[] } : {}), ...(anchor ? { anchor: String(anchor[1]) } : {}), ...(chamfered ? { chamfered: true } : {}) });
    }
  }
  return out;
}

/**
 * Distance test of a circle (via hole) against pad copper. Exact for circle, rect, oval, roundrect and custom pads made
 * of circles, lines, arcs, polygons and rects. Anything else is tested against a superset of its copper (a chamfered
 * pad as its unchamfered shape, an unknown shape or primitive as its bounding circle), so it can over-report a via in a
 * pad but never miss one, and a pad shape it does not model never stops the check.
 */
export function holeMeetsPad(vx: number, vy: number, rad: number, p: Pick<SmdPad, "x" | "y" | "ang" | "w" | "h" | "shape"> & Partial<Pick<SmdPad,"radiusRatio"|"primitives"|"anchor"|"chamfered">>): boolean {
  const a = p.ang * (Math.PI / 180);
  const dx = vx - p.x;
  const dy = vy - p.y;
  const u = dx * Math.cos(a) - dy * Math.sin(a); // into the pad frame (KiCad y-down, angle counter-clockwise)
  const v = dx * Math.sin(a) + dy * Math.cos(a);
  const hw = p.w / 2;
  const hh = p.h / 2;
  // far from every point the pad's copper can reach: no shape test needed (and no unmodelled shape can matter)
  if (Math.hypot(u, v) > padReach(p) + rad) return false;
  if (p.shape === "circle") return Math.hypot(u, v) <= hw + rad;
  if (p.shape === "custom") {
    const anchor = p.anchor === "rect" ? "rect" : "circle";
    if (holeMeetsPad(u,v,rad,{x:0,y:0,ang:0,w:p.w,h:p.h,shape:anchor})) return true;
    return (p.primitives ?? []).some(primitive => meetsPrimitive(u,v,rad,primitive));
  }
  // a chamfer only removes copper: the unchamfered shape is a superset
  if (p.shape === "roundrect" && !p.chamfered) {
    // KiCad PAD constructor defaults to 0.25: https://docs.kicad.org/doxygen/pad_8cpp_source.html
    const ratio = Math.max(0, Math.min(0.5, p.radiusRatio ?? 0.25));
    const radius = Math.min(p.w,p.h)*ratio;
    return Math.hypot(Math.max(0,Math.abs(u)-(hw-radius)),Math.max(0,Math.abs(v)-(hh-radius))) <= radius+rad;
  }
  if (p.shape === "oval") {
    const r = Math.min(hw, hh);
    return Math.hypot(Math.max(0, Math.abs(u) - (hw - r)), Math.max(0, Math.abs(v) - (hh - r))) <= r + rad;
  }
  if (p.shape === "rect" || p.shape === "roundrect") return Math.hypot(Math.max(0, Math.abs(u) - hw), Math.max(0, Math.abs(v) - hh)) <= rad;
  return true; // unmodelled shape (trapezoid, ...) and within its reach: counted as in the pad
}

/** Radius around the pad centre that contains all of its copper (generous for shapes it does not model). */
function padReach(p: Pick<SmdPad, "w" | "h" | "shape"> & Partial<Pick<SmdPad, "primitives">>): number {
  // a full diagonal also covers a trapezoid whose delta is at most the pad size
  const body = p.shape === "rect" || p.shape === "roundrect" || p.shape === "oval" || p.shape === "circle" ? Math.hypot(p.w, p.h) / 2 : Math.hypot(p.w, p.h);
  return Math.max(body, ...(p.primitives ?? []).map(primitiveReach));
}
function primitiveReach(node: SNode): number {
  const width = num(kid(node, "width")?.[1]);
  const pts: Array<[number, number]> = [];
  for (const key of ["start", "mid", "end", "center"]) { const n = kid(node, key); if (n) pts.push([num(n[1]), num(n[2])]); }
  for (const q of kids(kid(node, "pts") ?? [], "xy")) pts.push([num(q[1]), num(q[2])]);
  let reach = Math.max(0, ...pts.map(([x, y]) => Math.hypot(x, y)));
  if (node[0] === "gr_circle" && kid(node, "center") && kid(node, "end")) {
    const [cx, cy] = [num(kid(node, "center")![1]), num(kid(node, "center")![2])], [ex, ey] = [num(kid(node, "end")![1]), num(kid(node, "end")![2])];
    reach = Math.max(reach, Math.hypot(cx, cy) + Math.hypot(ex - cx, ey - cy));
  }
  const arc = arcCircle(node);
  if (arc) reach = Math.max(reach, Math.hypot(arc.cx, arc.cy) + arc.r);
  return reach + width / 2;
}
/** Circle through an arc primitive's start, mid and end; null for a degenerate or non-arc node. */
function arcCircle(node: SNode): { cx: number; cy: number; r: number; a0: number; a1: number; a2: number } | null {
  if (node[0] !== "gr_arc") return null;
  const s = kid(node, "start"), m = kid(node, "mid"), e = kid(node, "end");
  if (!s || !m || !e) return null;
  const [ax, ay, bx, by, qx, qy] = [num(s[1]), num(s[2]), num(m[1]), num(m[2]), num(e[1]), num(e[2])];
  const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, q2 = qx * qx + qy * qy;
  const cx = (a2 * (by - qy) + b2 * (qy - ay) + q2 * (ay - by)) / d, cy = (a2 * (qx - bx) + b2 * (ax - qx) + q2 * (bx - ax)) / d;
  return { cx, cy, r: Math.hypot(ax - cx, ay - cy), a0: Math.atan2(ay - cy, ax - cx), a1: Math.atan2(by - cy, bx - cx), a2: Math.atan2(qy - cy, qx - cx) };
}

function distanceSegment(x:number,y:number,ax:number,ay:number,bx:number,by:number):number {
  const length=(bx-ax)**2+(by-ay)**2,t=length ? Math.max(0,Math.min(1,((x-ax)*(bx-ax)+(y-ay)*(by-ay))/length)) : 0;
  return Math.hypot(x-ax-t*(bx-ax),y-ay-t*(by-ay));
}
function meetsPrimitive(x:number,y:number,radius:number,node:SNode):boolean {
  const width=num(kid(node,"width")?.[1]), filled=kid(node,"fill")?.[1] === "yes";
  const point=(key:string):[number,number]=>{const n=kid(node,key);return [num(n?.[1]),num(n?.[2])];};
  if(node[0]==="gr_circle") {const [cx,cy]=point("center"),[ex,ey]=point("end"),r=Math.hypot(ex-cx,ey-cy),d=Math.hypot(x-cx,y-cy);return filled ? d<=r+width/2+radius : width>0 && Math.abs(d-r)<=width/2+radius;}
  if(node[0]==="gr_line") {const [ax,ay]=point("start"),[bx,by]=point("end");return width>0 && distanceSegment(x,y,ax,ay,bx,by)<=radius+width/2;}
  let polygon:Array<[number,number]>;
  if(node[0]==="gr_poly") polygon=kids(kid(node,"pts")??[],"xy").map(q=>[num(q[1]),num(q[2])]);
  else if(node[0]==="gr_rect") {const [ax,ay]=point("start"),[bx,by]=point("end");polygon=[[ax,ay],[bx,ay],[bx,by],[ax,by]];}
  else if(node[0]==="gr_arc") {
    const arc=arcCircle(node);
    if(!arc) {const [ax,ay]=point("start"),[bx,by]=point("end");return width>0 && distanceSegment(x,y,ax,ay,bx,by)<=radius+width/2;}
    // on the arc's sweep (start -> mid -> end) the nearest point is radial; off it, the nearest is an end point
    const turn=(from:number,to:number)=>((to-from)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
    const ccw=turn(arc.a0,arc.a1)<=turn(arc.a0,arc.a2), sweep=ccw ? turn(arc.a0,arc.a2) : turn(arc.a2,arc.a0);
    const at=Math.atan2(y-arc.cy,x-arc.cx), on=(ccw ? turn(arc.a0,at) : turn(arc.a2,at))<=sweep;
    const [sx,sy]=point("start"),[ex,ey]=point("end");
    const d=on ? Math.abs(Math.hypot(x-arc.cx,y-arc.cy)-arc.r) : Math.min(Math.hypot(x-sx,y-sy),Math.hypot(x-ex,y-ey));
    return width>0 && d<=radius+width/2;
  }
  // unmodelled primitive (a bezier, ...): counted as copper anywhere within its reach
  else return Math.hypot(x,y)<=primitiveReach(node)+radius;
  if(polygon.length<3) return polygon.length>0 && Math.hypot(x,y)<=primitiveReach(node)+radius;
  let inside=false,edge=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {const [ax,ay]=polygon[j]!,[bx,by]=polygon[i]!;if((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;if(distanceSegment(x,y,ax,ay,bx,by)<=radius+width/2)edge=true;}
  return filled && inside || (filled || width>0) && edge;
}

/** Spans of depth-1 s-expressions starting with `key` (any whitespace after the keyword, so CRLF boards read the same). */
export function topLevelSpans(text: string, key: string): Array<[number, number]> {
  return sexprTopLevelSpans(text, key).map((s): [number, number] => [s.start, s.end]);
}

export function classifyVias(text: string): ViaClass[] {
  const pads = smdPads(parseSexpr(text));
  const out: ViaClass[] = [];
  for (const [s, e] of topLevelSpans(text, "via")) {
    const b = text.slice(s, e);
    const at = /\(at ([-\d.]+) ([-\d.]+)/.exec(b);
    const drill = /\(drill ([-\d.]+)/.exec(b);
    const size = /\(size ([-\d.]+)/.exec(b);
    if (!at || !drill || !size) continue;
    const [x, y] = [Number(at[1]), Number(at[2])];
    const layersBlk = /\(layers[^)]*\)/.exec(b)?.[0] ?? "";
    const layers = [...layersBlk.matchAll(/"([^"]+\.Cu)"/g)].map((m) => m[1]!);
    const type = /\(via\s+micro/.test(b) ? "micro" : /\(via\s+blind/.test(b) ? "blind" : "through";
    const net = /\(net "([^"]*)"\)/.exec(b)?.[1] ?? "";
    const uuid = /\(uuid "([^"]+)"\)/.exec(b)?.[1] ?? null;
    const lset = new Set(layers);
    const hit = pads.filter((p) => (p.layers.has("*.Cu") || [...p.layers].some((l) => lset.has(l))) && holeMeetsPad(x, y, Number(drill[1]) / 2, p));
    const need = type === "micro" || hit.length > 0;
    out.push({
      uuid,
      xy: [x, y],
      net,
      type,
      span: layers,
      diameter_mm: Number(size[1]),
      drill_mm: Number(drill[1]),
      in_component_lands: hit.map((p) => `${p.ref}.${p.pad}`).sort(),
      required_filling: need,
      required_copper_capping: need,
      native_filling: b.includes("(filling yes)"),
      native_capping: b.includes("(capping yes)"),
      span_: [s, e],
    });
  }
  return out;
}

export function viaBindings(boardPath: string, vias: ViaClass[]): { record: ViaBindings; missing: ViaClass[] } {
  const need = vias.filter((v) => v.required_filling);
  const missing = need.filter((v) => !(v.native_filling && v.native_capping));
  const extra = vias.filter((v) => !v.required_filling && (v.native_filling || v.native_capping));
  return {
    missing,
    record: {
      schema: "FLOW_VIA_PROCESS_BINDINGS_V1",
      board: boardPath,
      rule:
        "Via-in-pad (drill hole meets SMD pad copper) and every laser microvia: filled and copper-capped (IPC-4761 Type VII); other through vias: no requirement. Supplier capability not qualified.",
      counts: {
        vias: vias.length,
        through: vias.filter((v) => v.type === "through").length,
        micro: vias.filter((v) => v.type === "micro").length,
        via_in_pad: vias.filter((v) => v.in_component_lands.length).length,
        require_fill_cap: need.length,
        missing_native_before: missing.length,
        filled_not_required: extra.length,
      },
      bindings: need.map(({ span_: _s, ...rest }) => rest),
    },
  };
}

/** The board text with `(capping yes) (filling yes)` set on every via that needs them. */
export function applyViaBindings(text: string, missing: ViaClass[]): string {
  let t = text;
  for (const v of [...missing].sort((a, b) => b.span_[0] - a.span_[0])) {
    const [s, e] = v.span_;
    let b = t.slice(s, e);
    b = b.replace(/\(capping \w+\)\s*|\(filling \w+\)\s*/g, "");
    const eol = b.includes("\r\n") ? "\r\n" : "\n"; // keep a CRLF board CRLF
    b = b.replace(/(\(layers[^)]*\))/, `$1${eol}\t\t(capping yes)${eol}\t\t(filling yes)`);
    t = t.slice(0, s) + b + t.slice(e);
  }
  return t;
}
