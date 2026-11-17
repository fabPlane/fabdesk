/** Saved-board copper shapes used by destructive pruning (board millimetres). */
import { kid, kids, keepoutBlocks, num, parseSexpr, type SNode } from "../sexpr";
import { footprintPose } from "../review/geometry";
import { arcPoints, toBoard } from "../silk/shapes";
import { subtractCopperKeepouts, type CopperShape } from "../copper-contact";

export type LayerCopper = { shape: CopperShape; layers: string[]; net: string };
const point = (n: SNode | undefined): [number, number] => [num(n?.[1]), num(n?.[2])];
const object = ([x, y]: [number, number]) => ({ x, y });
const netOf = (n: SNode) => String(kid(n, "net")?.at(-1) ?? "");

export function routeCopper(node: SNode, stack: string[]): LayerCopper {
  const via = node[0] === "via";
  let layers = via ? (kid(node, "layers")?.slice(1) ?? []).map(String) : [String(kid(node, "layer")?.[1] ?? "")];
  if (via) {
    const a = stack.indexOf(layers[0]!), b = stack.indexOf(layers[1]!);
    if (a >= 0 && b >= 0) layers = stack.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  const path = via ? [point(kid(node, "at"))] : node[0] === "arc"
    ? arcPoints(point(kid(node, "start")), point(kid(node, "mid")), point(kid(node, "end")), .000001)
    : [point(kid(node, "start")), point(kid(node, "end"))];
  let arcPadding = 0;
  if (node[0] === "arc") {
    const [a, m, b] = [point(kid(node, "start")), point(kid(node, "mid")), point(kid(node, "end"))];
    const dist = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const cross = Math.abs((m![0] - a![0]) * (b![1] - a![1]) - (m![1] - a![1]) * (b![0] - a![0]));
    if (cross > 1e-12) {
      const radius = dist(a!, m!) * dist(m!, b!) * dist(b!, a!) / (2 * cross);
      const chord = Math.max(...path.slice(1).map((p, i) => dist(path[i]!, p)));
      // Enclose the true arc between samples so tessellation can never hide a live contact.
      const halfChord2 = chord * chord / 4;
      arcPadding = halfChord2 / (radius + Math.sqrt(Math.max(0, radius * radius - halfChord2)));
    }
  }
  const width = num(kid(node, via ? "size" : "width")?.[1], via ? .5 : .15);
  const points = path.map(object);
  return { net: netOf(node), layers, shape: { path: points, width: width + 2 * arcPadding,
    ...(node[0] === "segment" ? { exact: "straight-track" as const } : { inner: null }) } };
}

export function padCopper(text: string, stack: string[]): LayerCopper[] {
  const out: LayerCopper[] = [];
  for (const fp of kids(parseSexpr(text), "footprint")) {
    const pose = footprintPose(fp);
    for (const pad of kids(fp, "pad")) {
      if (pad[2] === "np_thru_hole") continue;
      const rawLayers = (kid(pad, "layers")?.slice(1) ?? []).map(String);
      const layers = pad[2] === "thru_hole" || rawLayers.includes("*.Cu") ? stack : rawLayers.filter(l => l.endsWith(".Cu"));
      const at = kid(pad, "at"), size = kid(pad, "size");
      const [x, y] = toBoard(pose, num(at?.[1]), num(at?.[2]));
      const rot = num(at?.[3]), w = num(size?.[1], .6), h = num(size?.[2], .6);
      const shape = String(pad[3]);
      const add = (s: CopperShape) => {
        const { exact, ...outer } = s;
        const unknown = kid(pad, "drill") || kid(pad, "chamfer") || kid(pad, "chamfer_ratio");
        out.push({ net: netOf(pad), layers, shape: unknown ? { ...outer, inner: null } : { ...outer, ...(exact ? { exact } : {}) } });
      };
      const transform = (px: number, py: number) => object(toBoard({ x, y, rot }, px, py));
      if (shape === "circle" || shape === "oval") {
        const r = shape === "circle" ? w / 2 : Math.min(w, h) / 2;
        const dx = shape === "oval" ? w / 2 - r : 0, dy = shape === "oval" ? h / 2 - r : 0;
        add({ path: [transform(-dx, -dy), transform(dx, dy)], width: 2 * r, exact: shape === "circle" ? "circle-pad" : "oval-pad" });
      } else if (shape === "rect" || shape === "roundrect") {
        // A rounded rectangle is exactly its inset rectangle buffered by the corner radius.
        const r = shape === "roundrect" ? Math.min(w, h) * Math.max(0, Math.min(.5, num(kid(pad, "roundrect_rratio")?.[1], .25))) : 0;
        const hw = w / 2 - r, hh = h / 2 - r;
        add({ polygon: { outline: [transform(-hw, -hh), transform(hw, -hh), transform(hw, hh), transform(-hw, hh)] }, radius: r, exact: shape === "rect" ? "rect-pad" : "roundrect-pad" });
      } else {
        // Unmodelled/custom lands conservatively retain copper within their full primitive reach.
        // Never delete a connection on the strength of a missing primitive model.
        let reach = Math.hypot(w, h);
        const visit = (n: SNode) => {
          if (["xy", "start", "mid", "end", "center"].includes(String(n[0]))) reach += 2 * Math.hypot(num(n[1]), num(n[2]));
          if (n[0] === "gr_arc") {
            for (const [px, py] of arcPoints(point(kid(n, "start")), point(kid(n, "mid")), point(kid(n, "end")))) reach = Math.max(reach, 2 * Math.hypot(px, py));
          }
          if (n[0] === "width") reach += Math.abs(num(n[1]));
          for (const c of n) if (Array.isArray(c)) visit(c);
        };
        visit(kid(pad, "primitives") ?? []);
        add({ path: [{ x, y }], width: reach * 2, inner: null });
      }
    }
  }
  return out;
}


/** Unknown/stale fills use zone outlines. Only an explicitly verified board uses fills. */
export function zoneCopper(text: string, fillsCurrent = false): LayerCopper[] {
  const root = parseSexpr(text);
  const netNames = new Map(kids(root, "net").map(n => [String(n[1]), String(n.at(-1))]));
  const zones = kids(root, "zone");
  const keepouts = zones.filter(zone => keepoutBlocks(zone, "copperpour"));
  const zoneLayers = (zone: SNode) => (kid(zone, "layers")?.slice(1) ?? [kid(zone, "layer")?.[1] ?? ""]).map(String);
  return zones.flatMap(zone => {
    if (kid(zone, "keepout")) return [];
    const raw = netOf(zone);
    const net = String(kid(zone, "net_name")?.[1] ?? netNames.get(raw) ?? raw);
    const polygons = fillsCurrent ? kids(zone, "filled_polygon") : kids(zone, "polygon");
    // Some minimal/legacy snapshots supply filled geometry only. It is still a
    // conservative terminal when no definition geometry is available.
    if (!fillsCurrent && !polygons.length) polygons.push(...kids(zone, "filled_polygon"));
    const layers = zoneLayers(zone);
    return polygons.flatMap(fill => (fillsCurrent ? [String(kid(fill, "layer")?.[1] ?? layers[0])] : layers).flatMap(layer => {
      const polygon = { outline: kids(kid(fill, "pts") ?? [], "xy").map(n => object(point(n))),
        holes: kids(fill, "hole").map(hole => kids(kid(hole, "pts") ?? hole, "xy").map(n => object(point(n)))) };
      const exclusions = fillsCurrent ? [] : keepouts.filter(k => zoneLayers(k).includes(layer) || zoneLayers(k).includes("*.Cu"))
        .flatMap(k => kids(k, "polygon").map(p => ({ outline: kids(kid(p, "pts") ?? [], "xy").map(n => object(point(n))) })));
      return subtractCopperKeepouts(polygon, exclusions).map(polygon => ({ net, layers: [layer], shape: { polygon, ...(fillsCurrent ? { exact: "current-fill" as const } : { inner: null }) } }));
    }));
  });
}
