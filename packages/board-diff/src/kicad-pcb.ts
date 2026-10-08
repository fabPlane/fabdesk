import {
  childBlocks,
  childNamed,
  parseAt,
  parseXy,
  propertyValue,
  quoted,
  roundMm,
  topLevelBlocks,
} from "./sexpr";
import { emptySnapshot, type BoardSnapshot, type ComponentSnapshot, type NetSnapshot, type Point, type TrackSnapshot } from "./types";

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

function padNodes(body: string): Array<{ pin: string; net?: string; code?: number }> {
  const out: Array<{ pin: string; net?: string; code?: number }> = [];
  for (const pad of childBlocks(body).filter((b) => b.name === "pad")) {
    const pin = quoted(pad.body);
    if (!pin) continue;
    const net = childNamed(pad.body, "net");
    if (!net) {
      out.push({ pin });
      continue;
    }
    const code = Number(/\(net\s+(-?\d+)/.exec(net.body)?.[1] ?? Number.NaN);
    const name = quoted(net.body);
    out.push({
      pin,
      ...(name ? { net: name } : {}),
      ...(Number.isFinite(code) ? { code } : {}),
    });
  }
  return out;
}

function trackId(start: Point, end: Point, layer: string, width: number, net?: string): string {
  const a = `${roundMm(start.x)},${roundMm(start.y)}`;
  const b = `${roundMm(end.x)},${roundMm(end.y)}`;
  const [left, right] = a < b ? [a, b] : [b, a];
  return `${left}-${right}@${layer}#${net ?? ""}w${roundMm(width)}`;
}

function parseSegment(body: string, netsByCode: Map<number, string>): TrackSnapshot | undefined {
  const startBlock = childNamed(body, "start");
  const endBlock = childNamed(body, "end");
  const start = startBlock ? parseXy(startBlock.body) : undefined;
  const end = endBlock ? parseXy(endBlock.body) : undefined;
  if (!start || !end) return undefined;
  const width = Number(childNamed(body, "width")?.body.match(/-?[\d.]+/)?.[0] ?? 0);
  const layer = childNamed(body, "layer") ? quoted(childNamed(body, "layer")!.body) ?? "F.Cu" : "F.Cu";
  const netNode = childNamed(body, "net");
  const code = netNode ? Number(/\(net\s+(-?\d+)/.exec(netNode.body)?.[1] ?? Number.NaN) : Number.NaN;
  const netName = netNode ? quoted(netNode.body) : undefined;
  const net = netName ?? (Number.isFinite(code) ? netsByCode.get(code) : undefined);
  return {
    id: trackId(start, end, layer, width, net),
    start,
    end,
    width,
    layer,
    ...(net ? { net } : {}),
  };
}

function outlineFromGraphics(text: string): Point[] {
  const points: Point[] = [];
  const push = (pt: Point | undefined) => {
    if (pt) points.push(pt);
  };
  for (const block of [...topLevelBlocks(text, "gr_line"), ...topLevelBlocks(text, "gr_rect"), ...topLevelBlocks(text, "gr_poly")]) {
    if (!block.body.includes("Edge.Cuts")) continue;
    if (block.name === "gr_poly") {
      for (const pt of block.body.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)) {
        if (pt[1] && pt[2]) points.push({ x: Number(pt[1]), y: Number(pt[2]) });
      }
      continue;
    }
    push(parseXy(childNamed(block.body, "start")?.body ?? ""));
    push(parseXy(childNamed(block.body, "end")?.body ?? ""));
  }
  return points;
}

/**
 * Parse a `.kicad_pcb` into components (by reference), nets, copper segments, and Edge.Cuts points.
 * Understands both legacy `(at x y [r])` and v10 `(transform (translate …))` footprints.
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
    const component: ComponentSnapshot = {
      ref,
      ...(value ? { value } : {}),
      ...(footprint ? { footprint } : {}),
      ...(place ? { x: place.x, y: place.y, rotation: place.rotation } : {}),
      ...(layer ? { layer } : {}),
    };
    snapshot.components.push(component);
    for (const pad of padNodes(block.body)) {
      if (!pad.net) continue;
      const existing = nets.get(pad.net) ?? { name: pad.net, ...(pad.code !== undefined ? { code: pad.code } : {}), nodes: [] };
      existing.nodes.push({ ref, pin: pad.pin });
      nets.set(pad.net, existing);
    }
  }

  for (const block of topLevelBlocks(text, "segment")) {
    const track = parseSegment(block.body, netsByCode);
    if (track) snapshot.tracks.push(track);
  }

  snapshot.nets = [...nets.values()].sort((a, b) => a.name.localeCompare(b.name));
  snapshot.outline = outlineFromGraphics(text);
  return snapshot;
}
