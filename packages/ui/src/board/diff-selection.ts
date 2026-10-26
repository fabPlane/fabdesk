import { parseSvgViewBox } from "./svg-coords";

export type DiffSelection = { kind: "part" | "net"; id: string; refs?: readonly string[] };
type Transform = { scale: number; x: number; y: number };
const identity: Transform = { scale: 1, x: 0, y: 0 };
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Highlight generated SVG geometry inside the image, keeping large boards out of the app DOM. */
export function selectDiffGeometry(source: string, selection: DiffSelection | null): { svg: string; found: boolean } {
  if (!selection) return { svg: source, found: false };
  const root = parseSvgViewBox(source);
  if (!root) return { svg: source, found: false };
  const opening = /<svg\b[^>]*>/.exec(source);
  const closing = source.lastIndexOf("</svg>");
  if (opening && closing > opening.index) {
    const begin = opening.index + opening[0].length;
    const inner = source.slice(begin, closing);
    if (/<svg\b/.test(inner)) {
      // Zoom each side independently. Cropping the outer viewBox around two
      // distant panels would squash the selection into an unreadable strip.
      let found = false;
      const panels = inner.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, panel => {
        const selected = selectDiffGeometry(panel, selection);
        found ||= selected.found;
        return selected.svg;
      });
      return found ? { svg: source.slice(0, begin) + panels + source.slice(closing), found: true }
        : { svg: source, found: false };
    }
  }
  const id = xml(selection.id);
  const refs = new Set((selection.refs ?? []).map(xml));
  const stack: Array<{ tag: string; transform: Transform; selected: boolean }> = [];
  const points: Array<{ x: number; y: number }> = [];
  const attrsOf = (tag: string) => Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g), m => [m[1]!, m[2] ?? m[3] ?? ""]));
  const markup = source.replace(/<\/?(?:svg|g)\b[^>]*>|<(?:rect|line|polyline|circle|path)\b[^>]*>/g, tag => {
    if (tag.startsWith("</")) { stack.pop(); return tag; }
    const name = /^<(\w+)/.exec(tag)?.[1];
    const attrs = attrsOf(tag);
    const parent = stack.at(-1) ?? { transform: identity, selected: false };
    const match = selection.kind === "part" ? attrs["data-ref"] === id
      : attrs["data-net"] === id || (attrs["data-ref"] !== undefined && refs.has(attrs["data-ref"]));
    const selected = parent.selected || match;
    let transform = parent.transform;
    if (name === "svg" && stack.length) {
      // Side-by-side panels use nested SVG viewports with xMidYMid meet scaling.
      const box = parseSvgViewBox(tag);
      if (box) {
        const width = Number(attrs.width), height = Number(attrs.height);
        const scale = Math.min(width / box.width, height / box.height);
        if (Number.isFinite(scale) && scale > 0) transform = {
          scale: parent.transform.scale * scale,
          x: parent.transform.x + parent.transform.scale * (Number(attrs.x ?? 0) + (width - box.width * scale) / 2 - box.x * scale),
          y: parent.transform.y + parent.transform.scale * (Number(attrs.y ?? 0) + (height - box.height * scale) / 2 - box.y * scale),
        };
      }
    }
    if ((name === "g" || name === "svg") && !tag.endsWith("/>")) stack.push({ tag: name, transform, selected });
    const add = (x: number, y: number) => {
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: transform.x + x * transform.scale, y: transform.y + y * transform.scale });
    };
    if (selected) {
      if (name === "rect") {
        const x = Number(attrs.x ?? 0), y = Number(attrs.y ?? 0);
        add(x, y); add(x + Number(attrs.width), y + Number(attrs.height));
      } else if (name === "circle") {
        const x = Number(attrs.cx), y = Number(attrs.cy), r = Number(attrs.r);
        add(x - r, y - r); add(x + r, y + r);
      } else if (name === "line") {
        add(Number(attrs.x1), Number(attrs.y1)); add(Number(attrs.x2), Number(attrs.y2));
      } else if (name === "polyline" || name === "path") {
        // Generated polylines and zone paths contain explicit M/L coordinate pairs.
        const values = (attrs.points ?? attrs.d ?? "").match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
        for (let i = 0; i + 1 < values.length; i += 2) add(values[i]!, values[i + 1]!);
      }
    }
    return match ? tag.replace(/\/?>(?=$)/, end => ` data-diff-selected="true"${end}`) : tag;
  });
  if (!points.length) return { svg: source, found: false };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = Math.max(maxX - minX + 6, Math.min(root.width, 16));
  const height = Math.max(maxY - minY + 6, Math.min(root.height, 12));
  const viewBox = `${(minX + maxX - width) / 2} ${(minY + maxY - height) / 2} ${width} ${height}`;
  const style = `<style>
    [data-diff-selected] > rect { fill: #2563eb !important; fill-opacity: .2 !important; stroke: #2563eb !important; stroke-width: .65 !important; }
    [data-diff-selected] > text { fill: #1d4ed8 !important; font-weight: 800; }
    [data-diff-selected]:not(g) { stroke: #2563eb !important; stroke-width: .65 !important; }
  </style>`;
  return { found: true, svg: markup.replace(/viewBox=(?:"[^"]*"|'[^']*')/, `viewBox="${viewBox}"`).replace(/<svg\b[^>]*>/, tag => tag + style) };
}
