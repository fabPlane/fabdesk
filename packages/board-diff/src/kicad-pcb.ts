import {
  closeOf,
  childBlocks,
  childNamed,
  parseAt,
  parseXy,
  propertyValue,
  quoted,
  roundMm,
  topLevelBlocks,
  unquote,
} from "./sexpr";
import {
  emptySnapshot,
  type BoardSnapshot,
  type ComponentSnapshot,
  type NetSnapshot,
  type PadSnapshot,
  type Point,
  type TrackSnapshot,
  type ViaSnapshot,
  type ZoneSnapshot,
} from "./types";

const ARC_SEGMENTS = 16;

function footprintLib(body: string): string | undefined {
  const match = /^\(footprint\s+"((?:[^"\\]|\\.)*)"/.exec(body);
  return match?.[1] === undefined ? undefined : match[1].replace(/\\(.)/g, "$1");
}

function footprintPlacement(body: string): { x: number; y: number; rotation: number } | undefined {
  const transform = childNamed(body, "transform");
  if (transform) {
    const t = /\(translate\s+(-?[\d.]+)\s+(-?[\d.]+)\)/.exec(transform.body);
    if (!t?.[1] || !t[2]) return undefined;
    return {
      x: Number(t[1]),
      y: Number(t[2]),
      rotation: Number(/\(rotate\s+(-?[\d.]+)\)/.exec(transform.body)?.[1] ?? 0),
    };
  }
  const at = childNamed(body, "at");
  return at ? parseAt(at.body) : parseAt(body);
}

function footprintLayer(body: string): string | undefined {
  const layer = childNamed(body, "layer");
  return layer ? quoted(layer.body) : undefined;
}

function footprintRef(body: string): string | undefined {
  return (
    propertyValue(body, "Reference") ??
    (/\(fp_text\s+reference\s+"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] === undefined
      ? undefined
      : /\(fp_text\s+reference\s+"((?:[^"\\]|\\.)*)"/.exec(body)![1]!.replace(/\\(.)/g, "$1"))
  );
}

function footprintValue(body: string): string | undefined {
  return (
    propertyValue(body, "Value") ??
    (/\(fp_text\s+value\s+"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] === undefined
      ? undefined
      : /\(fp_text\s+value\s+"((?:[^"\\]|\\.)*)"/.exec(body)![1]!.replace(/\\(.)/g, "$1"))
  );
}

function firstNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const n = Number(text.match(/-?[\d.]+/)?.[0]);
  return Number.isFinite(n) ? n : undefined;
}

function parseLayers(body: string): string[] {
  const layers = childNamed(body, "layers");
  if (layers) {
    return [...layers.body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]!));
  }
  const layer = childNamed(body, "layer");
  const name = layer ? quoted(layer.body) : undefined;
  return name ? [name] : [];
}

function parseNetRef(body: string, netsByCode: Map<number, string>): string | undefined {
  const named = childNamed(body, "net_name");
  if (named) {
    const name = quoted(named.body);
    if (name) return name;
  }
  const net = childNamed(body, "net");
  if (!net) return undefined;
  const name = quoted(net.body);
  if (name) return name;
  const code = Number(/\(net\s+(-?\d+)/.exec(net.body)?.[1] ?? Number.NaN);
  return Number.isFinite(code) ? netsByCode.get(code) : undefined;
}

function parseNetCode(body: string): number | undefined {
  const net = childNamed(body, "net");
  if (!net) return undefined;
  const code = Number(/\(net\s+(-?\d+)/.exec(net.body)?.[1] ?? Number.NaN);
  return Number.isFinite(code) ? code : undefined;
}

function parsePad(body: string): PadSnapshot | undefined {
  const pin = quoted(body);
  if (!pin) return undefined;
  const head = /^\(pad\s+"((?:[^"\\]|\\.)*)"\s+\S+\s+(\S+)/.exec(body);
  const shape = head?.[2];
  const size = childNamed(body, "size");
  const sizeNums = size?.body.match(/-?[\d.]+/g);
  const width = sizeNums?.[0] !== undefined ? Number(sizeNums[0]) : undefined;
  const height = sizeNums?.[1] !== undefined ? Number(sizeNums[1]) : width;
  const drillBlock = childNamed(body, "drill");
  const drill = firstNumber(drillBlock?.body);
  const net = quoted(childNamed(body, "net")?.body ?? "");
  const at = /^\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/.exec(childNamed(body, "at")?.body ?? "");
  return {
    pin,
    ...(shape ? { shape } : {}),
    ...(width !== undefined && Number.isFinite(width) ? { width } : {}),
    ...(height !== undefined && Number.isFinite(height) ? { height } : {}),
    ...(drill !== undefined && drill > 0 ? { drill } : {}),
    ...(net ? { net } : {}),
    ...(at?.[1] && at[2] ? { x: Number(at[1]), y: Number(at[2]), angle: Number(at[3] ?? 0) } : {}),
  };
}

function asPadSnapshot(pad: PadSnapshot & { code?: number }): PadSnapshot {
  return {
    pin: pad.pin,
    ...(pad.shape ? { shape: pad.shape } : {}),
    ...(pad.width !== undefined ? { width: pad.width } : {}),
    ...(pad.height !== undefined ? { height: pad.height } : {}),
    ...(pad.drill !== undefined ? { drill: pad.drill } : {}),
    ...(pad.net ? { net: pad.net } : {}),
    ...(pad.x !== undefined ? { x: pad.x } : {}),
    ...(pad.y !== undefined ? { y: pad.y } : {}),
    ...(pad.angle !== undefined ? { angle: pad.angle } : {}),
  };
}

/** `uuid` and legacy `tstamp` may be quoted or bare depending on the KiCad version. */
function footprintIdentity(body: string, name: string): string | undefined {
  const value = childNamed(body, name)?.body;
  return value ? /^\(\w+\s+"?([^"\s)]+)"?\s*\)/.exec(value)?.[1] : undefined;
}

function padNodes(body: string): Array<PadSnapshot & { code?: number }> {
  const out: Array<PadSnapshot & { code?: number }> = [];
  for (const pad of childBlocks(body).filter((b) => b.name === "pad")) {
    const parsed = parsePad(pad.body);
    if (!parsed) continue;
    const code = parseNetCode(pad.body);
    out.push({ ...parsed, ...(code !== undefined ? { code } : {}) });
  }
  return out;
}

function polylineKey(points: Point[]): string {
  const forward = points.map((p) => `${roundMm(p.x)},${roundMm(p.y)}`).join(";");
  const backward = [...points]
    .reverse()
    .map((p) => `${roundMm(p.x)},${roundMm(p.y)}`)
    .join(";");
  return forward < backward ? forward : backward;
}

function trackId(points: Point[], layer: string, width: number, net?: string): string {
  return `${polylineKey(points)}@${layer}#${net ?? ""}w${roundMm(width)}`;
}

function viaId(x: number, y: number, diameter: number, drill: number, net?: string): string {
  return `via:${roundMm(x)},${roundMm(y)}d${roundMm(diameter)}h${roundMm(drill)}#${net ?? ""}`;
}

function zoneId(points: Point[], layers: string[], net?: string): string {
  const pts = points.map((p) => `${roundMm(p.x)},${roundMm(p.y)}`).join(";");
  return `zone:${net ?? ""}|${[...layers].sort().join(",")}|${pts}`;
}

/**
 * Flatten the circular arc through `start`, `mid`, `end` into a polyline
 * (straight line when the three points are collinear). Ported from #239 board-geometry.
 */
export function flattenArc(start: Point, mid: Point, end: Point, segments = ARC_SEGMENTS): Point[] {
  const ax = start.x;
  const ay = start.y;
  const bx = mid.x;
  const by = mid.y;
  const cx = end.x;
  const cy = end.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [start, end];
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const angle = (x: number, y: number) => Math.atan2(y - uy, x - ux);
  const t0 = angle(ax, ay);
  const tm = angle(bx, by);
  const t1 = angle(cx, cy);
  const tau = 2 * Math.PI;
  const norm = (t: number) => ((t % tau) + tau) % tau;
  const ccw = norm(tm - t0) < norm(t1 - t0);
  const sweep = ccw ? norm(t1 - t0) : -norm(t0 - t1);
  const pts: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = t0 + (sweep * i) / segments;
    pts.push({ x: ux + Math.hypot(ax - ux, ay - uy) * Math.cos(t), y: uy + Math.hypot(ax - ux, ay - uy) * Math.sin(t) });
  }
  return pts;
}

function parseCopperStroke(
  body: string,
  netsByCode: Map<number, string>,
  kind: "segment" | "arc",
): TrackSnapshot | undefined {
  const startBlock = childNamed(body, "start");
  const endBlock = childNamed(body, "end");
  const start = startBlock ? parseXy(startBlock.body) : undefined;
  const end = endBlock ? parseXy(endBlock.body) : undefined;
  if (!start || !end) return undefined;
  const midBlock = kind === "arc" ? childNamed(body, "mid") : undefined;
  const mid = midBlock ? parseXy(midBlock.body) : undefined;
  const points = mid ? flattenArc(start, mid, end) : [start, end];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return undefined;
  const width = firstNumber(childNamed(body, "width")?.body) ?? 0;
  const layer = childNamed(body, "layer") ? (quoted(childNamed(body, "layer")!.body) ?? "F.Cu") : "F.Cu";
  const net = parseNetRef(body, netsByCode);
  return {
    id: trackId(points, layer, width, net),
    start: first,
    end: last,
    width,
    layer,
    ...(net ? { net } : {}),
    ...(points.length > 2 ? { points } : {}),
  };
}

function parseVia(body: string, netsByCode: Map<number, string>): ViaSnapshot | undefined {
  const at = childNamed(body, "at") ? parseXy(childNamed(body, "at")!.body) : parseXy(body);
  if (!at) return undefined;
  const diameter = firstNumber(childNamed(body, "size")?.body) ?? 0.6;
  const drill = firstNumber(childNamed(body, "drill")?.body) ?? 0.3;
  const net = parseNetRef(body, netsByCode);
  return {
    id: viaId(at.x, at.y, diameter, drill, net),
    x: at.x,
    y: at.y,
    diameter,
    drill,
    ...(net ? { net } : {}),
  };
}

function parseZone(body: string, netsByCode: Map<number, string>): ZoneSnapshot | undefined {
  const polygon = childNamed(body, "polygon") ?? childNamed(body, "filled_polygon");
  const ptsBody = polygon ? (childNamed(polygon.body, "pts")?.body ?? polygon.body) : "";
  const points: Point[] = [];
  for (const pt of ptsBody.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)) {
    if (pt[1] && pt[2]) points.push({ x: Number(pt[1]), y: Number(pt[2]) });
  }
  if (points.length < 3) return undefined;
  const layers = parseLayers(body);
  const net = parseNetRef(body, netsByCode);
  return {
    id: zoneId(points, layers, net),
    points,
    layers,
    ...(net ? { net } : {}),
  };
}

function outlineFromGraphics(text: string): { points: Point[]; paths: Point[][] } {
  const points: Point[] = [];
  const paths: Point[][] = [];
  for (const block of [...topLevelBlocks(text, "gr_line"), ...topLevelBlocks(text, "gr_rect"), ...topLevelBlocks(text, "gr_poly"), ...topLevelBlocks(text, "gr_arc"), ...topLevelBlocks(text, "gr_circle")]) {
    if (!block.body.includes("Edge.Cuts")) continue;
    if (block.name === "gr_arc") {
      const start = parseXy(childNamed(block.body, "start")?.body ?? ""), mid = parseXy(childNamed(block.body, "mid")?.body ?? ""), end = parseXy(childNamed(block.body, "end")?.body ?? "");
      if (start && mid && end) {
        const path = flattenArc(start, mid, end);
        points.push(...path);
        paths.push(path);
      }
      continue;
    }
    if (block.name === "gr_circle") {
      const center = parseXy(childNamed(block.body, "center")?.body ?? ""), end = parseXy(childNamed(block.body, "end")?.body ?? "");
      if (center && end) {
        const radius = Math.hypot(end.x - center.x, end.y - center.y);
        const path = Array.from({ length: ARC_SEGMENTS * 2 + 1 }, (_, i) => {
          const angle = (i / (ARC_SEGMENTS * 2)) * 2 * Math.PI;
          return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
        });
        points.push(...path);
        paths.push(path);
      }
      continue;
    }
    if (block.name === "gr_poly") {
      const path: Point[] = [];
      for (const pt of block.body.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)) {
        if (pt[1] && pt[2]) path.push({ x: Number(pt[1]), y: Number(pt[2]) });
      }
      points.push(...path);
      if (path.length > 1) paths.push([...path, path[0]!]);
      continue;
    }
    const start = parseXy(childNamed(block.body, "start")?.body ?? ""), end = parseXy(childNamed(block.body, "end")?.body ?? "");
    if (start) points.push(start);
    if (end) points.push(end);
    if (start && end) paths.push(block.name === "gr_rect" ? [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start] : [start, end]);
  }
  return { points, paths };
}

/** Refuse a wrong document or a partial write before interpreting it as a board with no parts. */
export function assertKicadPcbText(text: string): void {
  const source = text.trim();
  if (!/^\(kicad_pcb(?:\s|\))/.test(source) || closeOf(source, 0) !== source.length) throw new Error("Expected one complete KiCad PCB document");
}

/**
 * Parse a `.kicad_pcb` into components (by reference), nets, copper segments/arcs,
 * vias, zones, and Edge.Cuts points. Understands both legacy `(at x y [r])` and
 * v10 `(transform (translate …))` footprints.
 */
export function snapshotFromKicadPcb(text: string): BoardSnapshot {
  const snapshot = emptySnapshot();
  const netsByCode = new Map<number, string>();
  const nets = new Map<string, NetSnapshot>();

  for (const block of topLevelBlocks(text, "net")) {
    const code = Number(/\(net\s+(-?\d+)/.exec(block.body)?.[1] ?? Number.NaN);
    const name = quoted(block.body);
    if (!name || name === "" || !Number.isFinite(code)) continue;
    netsByCode.set(code, name);
    if (!nets.has(name)) nets.set(name, { name, code, nodes: [] });
  }

  for (const block of topLevelBlocks(text, "footprint")) {
    const ref = footprintRef(block.body);
    if (!ref) continue;
    const place = footprintPlacement(block.body);
    const value = footprintValue(block.body);
    const footprint = footprintLib(block.body);
    const layer = footprintLayer(block.body);
    const pads = padNodes(block.body);
    const uuid = footprintIdentity(block.body, "uuid") ?? footprintIdentity(block.body, "tstamp");
    const symbolPath = footprintIdentity(block.body, "path");
    const component: ComponentSnapshot = {
      ref,
      ...(uuid ? { uuid } : {}),
      ...(symbolPath ? { symbolPath } : {}),
      ...(value ? { value } : {}),
      ...(footprint ? { footprint } : {}),
      ...(place ? { x: place.x, y: place.y, rotation: place.rotation } : {}),
      ...(layer ? { layer } : {}),
      ...(pads.length > 0 ? { pads: pads.map(asPadSnapshot) } : {}),
    };
    snapshot.components.push(component);
    for (const pad of pads) {
      if (!pad.net) continue;
      const existing = nets.get(pad.net) ?? { name: pad.net, ...(pad.code !== undefined ? { code: pad.code } : {}), nodes: [] };
      existing.nodes.push({ ref, pin: pad.pin });
      nets.set(pad.net, existing);
    }
  }

  for (const block of topLevelBlocks(text, "segment")) {
    const track = parseCopperStroke(block.body, netsByCode, "segment");
    if (track) snapshot.tracks.push(track);
  }
  for (const block of topLevelBlocks(text, "arc")) {
    const track = parseCopperStroke(block.body, netsByCode, "arc");
    if (track) snapshot.tracks.push(track);
  }
  for (const block of topLevelBlocks(text, "via")) {
    const via = parseVia(block.body, netsByCode);
    if (via) snapshot.vias.push(via);
  }
  for (const block of topLevelBlocks(text, "zone")) {
    const zone = parseZone(block.body, netsByCode);
    if (zone) snapshot.zones.push(zone);
  }

  snapshot.nets = [...nets.values()].sort((a, b) => a.name.localeCompare(b.name));
  const outline = outlineFromGraphics(text);
  snapshot.outline = outline.points;
  snapshot.outlinePaths = outline.paths;
  return snapshot;
}
