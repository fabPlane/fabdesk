import { parseSvgViewBox } from "../board/svg-coords";
import { boxesIntersect, type Box } from "./strokes";

export type MarkupHit = {
  refdes: string[];
  nets: string[];
};

type ObjectBox = { kind: "refdes" | "net"; id: string; box: Box };
type Frame = { transform: { scale: number; x: number; y: number }; refdes?: string; net?: string };

const identity = { scale: 1, x: 0, y: 0 };

/** Cheap AABB hit-test of `data-ref` / `data-net` geometry against a marked region in SVG units. */
export function objectsInMarkupRegion(svg: string, region: Box): MarkupHit {
  const objects = collectSvgObjects(svg);
  const refdes = new Set<string>();
  const nets = new Set<string>();
  for (const object of objects) {
    if (!boxesIntersect(object.box, region)) continue;
    if (object.kind === "refdes") refdes.add(object.id);
    else nets.add(object.id);
  }
  return { refdes: [...refdes], nets: [...nets] };
}

export function collectSvgObjects(source: string): ObjectBox[] {
  if (!parseSvgViewBox(source)) return [];
  const stack: Frame[] = [];
  const byKey = new Map<string, Box>();
  const attrsOf = (tag: string) =>
    Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g), (m) => [m[1]!, m[2] ?? m[3] ?? ""]));
  const addPoint = (transform: Frame["transform"], points: Array<{ x: number; y: number }>, x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: transform.x + x * transform.scale, y: transform.y + y * transform.scale });
  };
  const include = (kind: "refdes" | "net", id: string, points: Array<{ x: number; y: number }>) => {
    if (!id || points.length === 0) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const box: Box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    if (box.w === 0) box.w = 1;
    if (box.h === 0) box.h = 1;
    const key = `${kind}:${id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, box);
      return;
    }
    const x = Math.min(existing.x, box.x);
    const y = Math.min(existing.y, box.y);
    byKey.set(key, {
      x,
      y,
      w: Math.max(existing.x + existing.w, box.x + box.w) - x,
      h: Math.max(existing.y + existing.h, box.y + box.h) - y,
    });
  };
  source.replace(/<\/?(?:svg|g)\b[^>]*>|<(?:rect|line|polyline|circle|path|text)\b[^>]*>/g, (tag) => {
    if (tag.startsWith("</")) {
      stack.pop();
      return tag;
    }
    const name = /^<(\w+)/.exec(tag)?.[1];
    const attrs = attrsOf(tag);
    const parent = stack.at(-1) ?? { transform: identity };
    let transform = parent.transform;
    if (name === "svg" && stack.length) {
      const box = parseSvgViewBox(tag);
      if (box) {
        const width = Number(attrs.width);
        const height = Number(attrs.height);
        const scale = Math.min(width / box.width, height / box.height);
        if (Number.isFinite(scale) && scale > 0) {
          transform = {
            scale: parent.transform.scale * scale,
            x: parent.transform.x + parent.transform.scale * (Number(attrs.x ?? 0) + (width - box.width * scale) / 2 - box.x * scale),
            y: parent.transform.y + parent.transform.scale * (Number(attrs.y ?? 0) + (height - box.height * scale) / 2 - box.y * scale),
          };
        }
      }
    }
    const refdes = attrs["data-ref"] ? decodeXml(attrs["data-ref"]) : parent.refdes;
    const net = attrs["data-net"] ? decodeXml(attrs["data-net"]) : parent.net;
    if ((name === "g" || name === "svg") && !tag.endsWith("/>")) {
      stack.push({ transform, ...(refdes ? { refdes } : {}), ...(net ? { net } : {}) });
    }
    const points: Array<{ x: number; y: number }> = [];
    if (name === "rect") {
      const x = Number(attrs.x ?? 0);
      const y = Number(attrs.y ?? 0);
      addPoint(transform, points, x, y);
      addPoint(transform, points, x + Number(attrs.width), y + Number(attrs.height));
    } else if (name === "circle") {
      const x = Number(attrs.cx);
      const y = Number(attrs.cy);
      const r = Number(attrs.r);
      addPoint(transform, points, x - r, y - r);
      addPoint(transform, points, x + r, y + r);
    } else if (name === "line") {
      addPoint(transform, points, Number(attrs.x1), Number(attrs.y1));
      addPoint(transform, points, Number(attrs.x2), Number(attrs.y2));
    } else if (name === "polyline" || name === "path" || name === "text") {
      const values = (attrs.points ?? attrs.d ?? `${attrs.x ?? ""} ${attrs.y ?? ""}`).match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      for (let i = 0; i + 1 < values.length; i += 2) addPoint(transform, points, values[i]!, values[i + 1]!);
    }
    if (refdes) include("refdes", refdes, points);
    if (net) include("net", net, points);
    return tag;
  });
  return [...byKey.entries()].map(([key, box]) => {
    const [kind, ...rest] = key.split(":");
    return { kind: kind === "net" ? "net" : "refdes", id: rest.join(":"), box };
  });
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
