/** Saved-board copper shapes used by destructive pruning (board millimetres). */
import { kid, kids, keepoutBlocks, num, parseSexpr, type SNode } from "../sexpr";
import { footprintPose } from "../review/geometry";
import { arcPoints, toBoard } from "../silk/shapes";
import { copperOuterCircle, subtractCopperKeepouts, type CopperShape } from "../copper-contact";

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
  let width = num(kid(node, via ? "size" : "width")?.[1], via ? .5 : .15);
  if (via) for (const layer of kids(kid(node, "padstack") ?? [], "layer")) {
    const size = kid(layer, "size"), offset = kid(layer, "offset");
    const diameter = Math.max(Math.abs(num(size?.[1], width)), Math.abs(num(size?.[2], num(size?.[1], width))));
    width = Math.max(width, diameter + 2 * Math.hypot(num(offset?.[1]), num(offset?.[2])));
  }
  const points = path.map(object);
  return { net: netOf(node), layers, shape: node[0] === "segment" ? { path: points, width, exact: "straight-track" } : { ...copperOuterCircle(points, width / 2 + arcPadding), ...(via ? {} : { centerline: { path: points, width: width + 2 * arcPadding } }) } };
}

// Known non-copper properties are deliberately explicit: a future field must
// opt into this model before it can participate in destructive cleanup.
const padFields = new Set(["at", "size", "layers", "net", "uuid", "tstamp", "locked", "drill", "offset", "rect_delta", "roundrect_rratio", "chamfer_ratio", "chamfer", "options", "primitives", "padstack", "pinfunction", "pintype", "property", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_width", "thermal_gap", "thermal_bridge_width", "thermal_bridge_angle", "remove_unused_layers", "keep_end_layers", "tenting"]);
const geometryFields = new Set(["shape", "size", "offset", "rect_delta", "roundrect_rratio", "chamfer_ratio", "chamfer", "options", "primitives", "drill"]);
const primitiveFields = new Set(["start", "mid", "end", "center", "pts", "width", "fill", "stroke"]);
const primitiveKinds = new Set(["gr_line", "gr_rect", "gr_poly", "gr_circle", "gr_arc", "gr_curve"]);
const childNodes = (n: SNode) => n.filter((v): v is SNode => Array.isArray(v));
const allFields = (n: SNode, allowed: Set<string>) => childNodes(n).every(c => allowed.has(String(c[0])));

function unknownGeometry(n: SNode): boolean {
  for (const c of childNodes(n)) {
    const tag = String(c[0]);
    if (tag === "options") {
      if (!allFields(c, new Set(["anchor", "clearance"])) || childNodes(c).some(v => childNodes(v).length > 0)) return true;
      if (kid(c, "clearance") && !["outline", "convexhull"].includes(String(kid(c, "clearance")?.[1]))) return true;
      if (kid(c, "anchor") && !["rect", "circle"].includes(String(kid(c, "anchor")?.[1]))) return true;
    } else if (tag === "drill") {
      if (!allFields(c, new Set(["offset"]))) return true;
      if (childNodes(c).some(v => childNodes(v).length > 0)) return true;
    } else if (tag === "primitives") {
      for (const g of childNodes(c)) {
        if (!primitiveKinds.has(String(g[0])) || !allFields(g, primitiveFields)) return true;
        for (const v of childNodes(g)) {
          if (v[0] === "pts") { if (!allFields(v, new Set(["xy"])) || childNodes(v).some(p => childNodes(p).length > 0)) return true; }
          else if (v[0] === "stroke") { if (!allFields(v, new Set(["width", "type"])) || childNodes(v).some(p => childNodes(p).length > 0)) return true; }
          else if (childNodes(v).length) return true;
        }
      }
    } else if (tag !== "padstack" && childNodes(c).length) {
      // Tenting affects mask only. Everything else needs an explicit model.
      if (tag !== "tenting" || !allFields(c, new Set(["front", "back"])) || childNodes(c).some(v => childNodes(v).length)) return true;
    }
  }
  return false;
}

function unknownPad(pad: SNode): boolean {
  if (pad.slice(4).some(c => !Array.isArray(c) && c !== "locked") || !allFields(pad, padFields) || unknownGeometry(pad)) return true;
  if (!["smd", "thru_hole", "np_thru_hole", "connect"].includes(String(pad[2])) ||
    !["circle", "oval", "rect", "roundrect", "trapezoid", "custom"].includes(String(pad[3]))) return true;
  const ps = kid(pad, "padstack");
  if (!ps) return false;
  if (!allFields(ps, new Set(["mode", "layer"])) || !["custom", "front_inner_back", "normal"].includes(String(kid(ps, "mode")?.[1]))) return true;
  if (childNodes(kid(ps, "mode") ?? []).length) return true;
  return kids(ps, "layer").some(layer => !allFields(layer, geometryFields) || unknownGeometry(layer) ||
    (kid(layer, "shape") && !["circle", "oval", "rect", "roundrect", "trapezoid", "custom"].includes(String(kid(layer, "shape")?.[1]))));
}

/** Inherit unspecified geometry, and inspect every definition regardless of mode/layer name. */
function padLands(pad: SNode): SNode[] {
  return [pad, ...kids(kid(pad, "padstack") ?? [], "layer").map(layer => {
    const overrides = childNodes(layer);
    const tags = new Set(overrides.map(c => c[0]));
    return ["pad", pad[1]!, pad[2]!, kid(layer, "shape")?.[1] ?? pad[3]!,
      ...childNodes(pad).filter(c => !tags.has(c[0])), ...overrides] as SNode;
  })];
}
function identicalLands(lands: SNode[]): boolean {
  const signature = (land: SNode) => JSON.stringify([land[3], ...[...geometryFields].filter(k => k !== "shape").map(k => kid(land, k) ?? null)]);
  return lands.every(land => signature(land) === signature(lands[0]!));
}

const footprintFields = new Set(["layer", "at", "transform", "uuid", "tstamp", "locked", "placed", "property", "fp_text", "fp_text_box", "fp_line", "fp_rect", "fp_poly", "fp_circle", "fp_arc", "fp_curve", "pad", "zone", "model", "attr", "descr", "tags", "path", "sheetname", "sheetfile", "autoplace_cost90", "autoplace_cost180", "solder_mask_margin", "solder_paste_margin", "solder_paste_ratio", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_width", "thermal_gap", "thermal_bridge_width", "thermal_bridge_angle", "embedded_fonts", "embedded_files", "duplicate_pad_numbers_are_jumpers", "allow_missing_courtyard", "private_layers", "net_tie_pad_groups"]);
function unknownFootprint(fp: SNode): boolean {
  if (!allFields(fp, footprintFields)) return true;
  // Footprint graphics/zones on copper have no certified connectivity model.
  return childNodes(fp).some(g => g[0] !== "pad" && g[0] !== "layer" &&
    (g[0] === "zone" ? !kid(g, "keepout") : String(kid(g, "layer")?.[1] ?? "").endsWith(".Cu")));
}

/** Courtyard (both sides), or all padstack lands and footprint copper if absent. */
function footprintBound(fp: SNode, pads: SNode[]): CopperShape {
  const pose = footprintPose(fp);
  const graphics = childNodes(fp).filter(g => String(g[0]).startsWith("fp_") || String(kid(g,"layer")?.[1] ?? "").endsWith(".Cu"));
  const courtyard = graphics.filter(g => String(kid(g, "layer")?.[1] ?? "").endsWith("CrtYd"));
  const points: Array<[number, number]> = [];
  const addGraphic = (g: SNode) => {
    points.push(...graphicPoints(g));
  };
  if (courtyard.length) courtyard.forEach(addGraphic);
  else {
    for (const pad of pads) {
      const at = kid(pad, "at"), x = num(at?.[1]), y = num(at?.[2]);
      // Pad angles are absolute in the saved board; express them locally here.
      const rot = num(at?.[3]) - pose.rot;
      for (const land of padLands(pad)) {
        const [hx, hy] = landExtent(land);
        for (const [px, py] of [[-hx,-hy],[-hx,hy],[hx,-hy],[hx,hy]] as Array<[number,number]>) points.push(toBoard({x,y,rot},px,py));
      }
    }
    graphics.filter(g => String(kid(g,"layer")?.[1] ?? "").endsWith(".Cu")).forEach(addGraphic);
    kids(fp,"zone").filter(g => !kid(g,"keepout")).forEach(addGraphic);
  }
  if (!points.length) points.push([0,0]);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { polygon: { outline: [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(p => object(toBoard(pose,p[0]!,p[1]!))) }, inner: null };
}

/** Control-point bounds for curves, full circles for circular/arc primitives. */
function graphicPoints(primitive: SNode): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  let stroke = 0;
  const visit = (n: SNode) => {
    if (["xy", "start", "mid", "end", "center"].includes(String(n[0]))) coords.push(point(n));
    if (n[0] === "width") stroke = Math.max(stroke, Math.abs(num(n[1])) / 2);
    for (const c of n) if (Array.isArray(c)) visit(c);
  };
  visit(primitive);
  if (["gr_circle", "fp_circle"].includes(String(primitive[0]))) {
    const c = point(kid(primitive, "center")), e = point(kid(primitive, "end"));
    const r = Math.hypot(e[0]-c[0],e[1]-c[1]);
    coords.push([c[0]-r,c[1]-r],[c[0]+r,c[1]+r]);
  } else if (["gr_arc", "fp_arc"].includes(String(primitive[0]))) {
    // Full circumcircle encloses every sweep, including major arcs.
    const [a,b,c] = [point(kid(primitive,"start")),point(kid(primitive,"mid")),point(kid(primitive,"end"))];
    const d = 2*(a![0]*(b![1]-c![1])+b![0]*(c![1]-a![1])+c![0]*(a![1]-b![1]));
    if (Math.abs(d) > 1e-12) {
      const q = (p: [number,number]) => p[0]**2+p[1]**2;
      const cx=(q(a!)*(b![1]-c![1])+q(b!)*(c![1]-a![1])+q(c!)*(a![1]-b![1]))/d;
      const cy=(q(a!)*(c![0]-b![0])+q(b!)*(a![0]-c![0])+q(c!)*(b![0]-a![0]))/d;
      const r=Math.hypot(a![0]-cx,a![1]-cy);
      coords.push([cx-r,cy-r],[cx+r,cy+r]);
    }
  }
  return coords.flatMap(([x,y]) => [[x-stroke,y-stroke],[x+stroke,y+stroke]] as Array<[number,number]>);
}

/** Full rectangular extent; cuts never shrink a retention bound. */
function landExtent(land: SNode): [number, number] {
  const size = kid(land, "size"), w = num(size?.[1], .6), h = num(size?.[2], .6);
  const delta = kid(land, "rect_delta");
  let hx = Math.abs(w) / 2 + Math.abs(num(delta?.[2])) / 2;
  let hy = Math.abs(h) / 2 + Math.abs(num(delta?.[1])) / 2;
  for (const primitive of childNodes(kid(land, "primitives") ?? [])) {
    for (const [px,py] of graphicPoints(primitive)) { hx = Math.max(hx,Math.abs(px)); hy = Math.max(hy,Math.abs(py)); }
  }
  for (const offset of [kid(kid(land,"drill") ?? [],"offset"),kid(land,"offset")]) {
    hx += Math.abs(num(offset?.[1])); hy += Math.abs(num(offset?.[2]));
  }
  return [hx, hy];
}

export function padCopper(text: string, stack: string[]): LayerCopper[] {
  const out: LayerCopper[] = [];
  const root = parseSexpr(text);
  const routeNets = new Set(["segment", "via", "arc"].flatMap(kind => kids(root, kind).map(netOf)));
  for (const fp of kids(root, "footprint")) {
    const pose = footprintPose(fp);
    const pads = kids(fp, "pad");
    const footprintUnknown = unknownFootprint(fp);
    const fallback = () => footprintBound(fp, pads);
    if (footprintUnknown && !pads.length) {
      // A netless copper graphic can contact any incident route. With no pad
      // to name its net, preserve those possible terminals for every route net.
      for (const net of routeNets) out.push({ net, layers: stack, shape: fallback() });
    }
    for (const pad of pads) {
      if (pad[2] === "np_thru_hole" && !unknownPad(pad) && !footprintUnknown) continue;
      const rawLayers = (kid(pad, "layers")?.slice(1) ?? []).map(String);
      const layers = pad[2] === "thru_hole" || rawLayers.includes("*.Cu") ? stack : rawLayers.filter(l => l.endsWith(".Cu"));
      const at = kid(pad, "at"), size = kid(pad, "size");
      const [x, y] = toBoard(pose, num(at?.[1]), num(at?.[2]));
      const rot = num(at?.[3]), w = num(size?.[1], .6), h = num(size?.[2], .6);
      const lands = padLands(pad);
      const unmodelled = footprintUnknown || unknownPad(pad);
      if (unmodelled) {
        out.push({ net: netOf(pad), layers: stack, shape: fallback() });
        continue;
      }
      const shape = String(pad[3]);
      const transform = (px: number, py: number) => object(toBoard({ x, y, rot }, px, py));
      const unknown = !identicalLands(lands) || kid(pad, "drill") || kid(pad, "chamfer") || kid(pad, "chamfer_ratio") || kid(pad, "offset") || kid(pad, "rect_delta") || kid(pad, "primitives") || kid(pad, "options") ||
        !["circle", "oval", "rect", "roundrect"].includes(shape);
      const add = (s: CopperShape) => out.push({ net: netOf(pad), layers, shape: s });
      if (unknown) {
        // Bound the full rectangle, ignoring rounding/chamfer cuts. Include both
        // offset directions and trapezoid deltas before rotating into board space.
        let hx = 0, hy = 0;
        for (const land of lands) {
          const [lx, ly] = landExtent(land);
          hx = Math.max(hx, lx); hy = Math.max(hy, ly);
        }
        add(copperOuterCircle([transform(-hx,-hy),transform(hx,-hy),transform(hx,hy),transform(-hx,hy)],0,.000001,{x,y}));
        continue;
      }
      if (shape === "circle" || shape === "oval") {
        const r = shape === "circle" ? w / 2 : Math.min(w, h) / 2;
        const dx = shape === "oval" ? w / 2 - r : 0, dy = shape === "oval" ? h / 2 - r : 0;
        add({ path: [transform(-dx, -dy), transform(dx, dy)], width: 2 * r, exact: shape === "circle" ? "circle-pad" : "oval-pad" });
      } else if (shape === "rect" || shape === "roundrect") {
        // A rounded rectangle is exactly its inset rectangle buffered by the corner radius.
        const r = shape === "roundrect" ? Math.min(w, h) * Math.max(0, Math.min(.5, num(kid(pad, "roundrect_rratio")?.[1], .25))) : 0;
        const hw = w / 2 - r, hh = h / 2 - r;
        add({ polygon: { outline: [transform(-hw, -hh), transform(hw, -hh), transform(hw, hh), transform(-hw, hh)] }, radius: r, exact: shape === "rect" ? "rect-pad" : "roundrect-pad" });
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
