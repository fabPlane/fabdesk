/** Board geometry the review reads beyond the shared board model: every footprint with its flags, outline, courtyards. */
import { kid, kids, num, type SNode } from "../sexpr";

export interface PartPad {
  n: string;
  net: string;
  x: number;
  y: number;
}

export interface Part {
  ref: string;
  value: string;
  /** `F` or `B`. */
  side: string;
  x: number;
  y: number;
  rot: number;
  flags: string[];
  pads: PartPad[];
  props: Record<string, string>;
}

export function footprintPose(fp: SNode): { x: number; y: number; rot: number } {
  const tr = kid(fp, "transform");
  if (tr) {
    const t = kid(tr, "translate");
    return { x: num(t?.[1]), y: num(t?.[2]), rot: num(kid(tr, "rotate")?.[1]) };
  }
  const at = kid(fp, "at");
  return { x: num(at?.[1]), y: num(at?.[2]), rot: num(at?.[3]) };
}

export const mod360 = (r: number) => ((r % 360) + 360) % 360;

/** Footprints with pads in board coordinates, flags (dnp, exclude_from_bom ...), side, value. */
export function boardParts(root: SNode): Part[] {
  const out: Part[] = [];
  for (const fp of kids(root, "footprint")) {
    const props: Record<string, string> = {};
    for (const p of kids(fp, "property")) props[String(p[1])] = String(p[2] ?? "");
    const attr = kid(fp, "attr") ?? [];
    const flags = new Set(attr.slice(1).filter((x): x is string => typeof x === "string"));
    const dnp = kid(fp, "dnp");
    if (dnp || flags.has("dnp")) flags.add("dnp");
    const { x, y, rot } = footprintPose(fp);
    const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
    const pads: PartPad[] = [];
    for (const pad of kids(fp, "pad")) {
      const a = kid(pad, "at");
      const px = num(a?.[1]), py = num(a?.[2]);
      const net = kid(pad, "net");
      pads.push({ n: String(pad[1]), net: net ? String(net[net.length - 1] ?? "") : "", x: x + px * c + py * s, y: y - px * s + py * c });
    }
    out.push({ ref: props["Reference"] ?? "", value: props["Value"] ?? "", side: String(kid(fp, "layer")?.[1] ?? "F")[0]!, x, y, rot: mod360(rot), flags: [...flags].sort(), pads, props });
  }
  return out;
}

export type Box = [number, number, number, number];

const EDGE_KINDS = new Set(["gr_line", "gr_rect", "gr_arc", "gr_poly", "gr_circle"]);
const EDGE_POINTS = new Set(["start", "end", "xy", "mid", "center"]);

function collectPoints(n: SNode, out: Array<[number, number]>) {
  for (const c of n) {
    if (!Array.isArray(c)) continue;
    if (typeof c[0] === "string" && EDGE_POINTS.has(c[0]) && typeof c[1] === "string" && typeof c[2] === "string" && /^[-\d.]+$/.test(c[1]) && /^[-\d.]+$/.test(c[2]))
      out.push([Number(c[1]), Number(c[2])]);
    collectPoints(c, out);
  }
}

/** Bounding box of the Edge.Cuts graphics (x0, y0, x1, y1), as the toolkit's review reads it. */
export function boardOutline(root: SNode): Box | null {
  const pts: Array<[number, number]> = [];
  for (const g of root) {
    if (!Array.isArray(g) || typeof g[0] !== "string" || !EDGE_KINDS.has(g[0])) continue;
    if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
    collectPoints(g, pts);
  }
  if (!pts.length) return null;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Courtyard bounding box of a footprint in its own frame; pads when it has no courtyard; zero when neither. */
export function localBox(fp: SNode): Box {
  const xs: number[] = [], ys: number[] = [];
  for (const g of fp) {
    if (!Array.isArray(g) || !["fp_line", "fp_rect", "fp_poly", "fp_circle"].includes(String(g[0]))) continue;
    const layer = kid(g, "layer");
    if (!layer || !String(layer[1]).includes("CrtYd")) continue;
    if (g[0] === "fp_circle") {
      const c = kid(g, "center"), e = kid(g, "end");
      const cx = num(c?.[1]), cy = num(c?.[2]);
      const rr = Math.hypot(num(e?.[1]) - cx, num(e?.[2]) - cy);
      xs.push(cx - rr, cx + rr);
      ys.push(cy - rr, cy + rr);
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
    if (pts)
      for (const xy of kids(pts, "xy")) {
        xs.push(num(xy[1]));
        ys.push(num(xy[2]));
      }
  }
  if (!xs.length)
    for (const pad of kids(fp, "pad")) {
      const at = kid(pad, "at"), size = kid(pad, "size");
      const w = num(size?.[1]) / 2 + 0.25, h = num(size?.[2]) / 2 + 0.25;
      xs.push(num(at?.[1]) - w, num(at?.[1]) + w);
      ys.push(num(at?.[2]) - h, num(at?.[2]) + h);
    }
  if (!xs.length) return [0, 0, 0, 0];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function worldBox(box: Box, x: number, y: number, rot: number): Box {
  const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
  const pts = [box[0], box[2]].flatMap((px) => [box[1], box[3]].map((py): [number, number] => [x + px * c + py * s, y - px * s + py * c]));
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

export interface Mouth {
  point: [number, number];
  normal: [number, number];
  side: string;
  box: Box;
  /** Contact-pad positions in the board frame. */
  sig: Array<[number, number]>;
}

/** Where a connector's plug enters: the courtyard side opposite the contact-pad centroid. Null when it has no contact pads. */
export function mouthOf(fp: SNode): Mouth | null {
  const { x, y, rot } = footprintPose(fp);
  const box = worldBox(localBox(fp), x, y, rot);
  const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
  const sig: Array<[number, number]> = [];
  for (const pad of kids(fp, "pad")) {
    if (/^[A-Z]?\d+$/.test(String(pad[1]))) {
      const at = kid(pad, "at");
      const px = num(at?.[1]), py = num(at?.[2]);
      sig.push([x + px * c + py * s, y - px * s + py * c]);
    }
  }
  if (!sig.length) return null;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const gx = sig.reduce((a, p) => a + p[0], 0) / sig.length, gy = sig.reduce((a, p) => a + p[1], 0) / sig.length;
  const dx = cx - gx, dy = cy - gy;
  const side = String(kid(fp, "layer")?.[1] ?? "F")[0]!;
  if (Math.abs(dx) >= Math.abs(dy)) return { point: [dx > 0 ? box[2] : box[0], cy], normal: [dx > 0 ? 1 : -1, 0], side, box, sig };
  return { point: [cx, dy > 0 ? box[3] : box[1]], normal: [0, dy > 0 ? 1 : -1], side, box, sig };
}

/** Nets that have a poured (filled) copper zone. */
export function pouredNets(root: SNode): Set<string> {
  const out = new Set<string>();
  for (const z of kids(root, "zone")) if (kid(z, "filled_polygon")) out.add(String(kid(z, "net_name")?.slice(-1)[0] ?? ""));
  return out;
}
