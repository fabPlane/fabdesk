import { encodePng, parseGerber, type ParsedGerber } from "@fabdesk/board-art";
import { gerberBounds, rasterizeGerber, type Raster } from "./raster";
import type { ClassifiedFile, LayerKind, LayerRender, LayerSide } from "./types";

const COLORS: Record<LayerKind, [number, number, number]> = {
  copper: [196, 86, 42],
  mask: [20, 96, 52],
  paste: [188, 188, 196],
  silk: [236, 236, 236],
  outline: [40, 40, 40],
  drill: [20, 20, 20],
  other: [90, 90, 110],
};

export function renderLayerSvg(parsed: ParsedGerber, color: string, title: string): string {
  const box = gerberBounds(parsed, 0.4);
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const byId = new Map(parsed.apertures.map((a) => [a.id, a]));
  const parts: string[] = [];
  for (const op of parsed.ops) {
    if (op.op === "flash") {
      const ap = byId.get(op.aperture);
      if (!ap) continue;
      if (ap.kind === "C")
        parts.push(`<circle cx="${op.x}" cy="${op.y}" r="${ap.d / 2}" fill="${color}"/>`);
      else
        parts.push(
          `<rect x="${op.x - ap.w / 2}" y="${op.y - ap.h / 2}" width="${ap.w}" height="${ap.h}"${ap.kind === "O" ? ` rx="${Math.min(ap.w, ap.h) / 2}"` : ""} fill="${color}"/>`,
        );
    } else if (op.op === "draw") {
      const ap = byId.get(op.aperture);
      const sw = ap?.kind === "C" ? ap.d : ap ? Math.min(ap.w, ap.h) : 0.15;
      parts.push(
        `<line x1="${op.x1}" y1="${op.y1}" x2="${op.x2}" y2="${op.y2}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`,
      );
    } else if (op.points.length) {
      const d = op.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
      parts.push(`<path d="${d}" fill="${color}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.minX} ${box.minY} ${w} ${h}" width="${Math.round(w * 12)}" height="${Math.round(h * 12)}" data-layer="${escapeAttr(title)}"><rect x="${box.minX}" y="${box.minY}" width="${w}" height="${h}" fill="#111"/><g>${parts.join("")}</g></svg>\n`;
}

export function renderLayerPng(parsed: ParsedGerber, kind: LayerKind): Uint8Array {
  const [r, g, b] = COLORS[kind];
  const raster = rasterizeGerber(parsed, { scale: 28, maxPx: 720 });
  return encodePng(rgbaFromRaster(raster, r, g, b));
}

export function renderCompositePng(
  layers: Array<{ parsed: ParsedGerber; kind: LayerKind }>,
): Uint8Array {
  if (layers.length === 0) return encodePng({ width: 2, height: 2, data: new Uint8Array(16) });
  const bounds = layers.reduce((box, layer) => {
    const b = gerberBounds(layer.parsed, 0.4);
    return {
      minX: Math.min(box.minX, b.minX),
      minY: Math.min(box.minY, b.minY),
      maxX: Math.max(box.maxX, b.maxX),
      maxY: Math.max(box.maxY, b.maxY),
    };
  }, gerberBounds(layers[0]!.parsed, 0.4));
  const base = rasterizeGerber(layers[0]!.parsed, { bounds, scale: 24, maxPx: 720 });
  const rgba = new Uint8Array(base.width * base.height * 4);
  rgba.fill(17);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (const layer of layers) {
    const [r, g, b] = COLORS[layer.kind];
    const rast = rasterizeGerber(layer.parsed, { bounds, scale: base.scale, maxPx: 720 });
    overlay(rgba, rast, r, g, b, layer.kind === "copper" ? 220 : 160);
  }
  return encodePng({ width: base.width, height: base.height, data: rgba });
}

export function layerRenders(
  files: readonly ClassifiedFile[],
  write: (rel: string, bytes: Uint8Array | string) => string,
): LayerRender[] {
  const out: LayerRender[] = [];
  const parsedLayers: Array<{ file: ClassifiedFile; parsed: ParsedGerber }> = [];
  for (const file of files) {
    if (file.kind === "drill" || file.kind === "other") continue;
    try {
      parsedLayers.push({ file, parsed: parseGerber(file.body) });
    } catch {
      continue;
    }
  }
  for (const { file, parsed } of parsedLayers) {
    const stem = stemName(file.name);
    const color = cssColor(COLORS[file.kind]);
    const svg = renderLayerSvg(parsed, color, file.name);
    const png = renderLayerPng(parsed, file.kind);
    out.push({
      layer: file.name,
      kind: file.kind,
      side: file.side,
      svg,
      svgPath: write(`${stem}.svg`, svg),
      pngPath: write(`${stem}.png`, png),
      bounds: gerberBounds(parsed, 0.4),
    });
  }
  const top = parsedLayers.filter((l) => l.file.side === "top" || l.file.kind === "outline");
  const bot = parsedLayers.filter((l) => l.file.side === "bottom" || l.file.kind === "outline");
  if (top.length)
    out.push(compositeEntry("top-composite", "top", top, write));
  if (bot.length)
    out.push(compositeEntry("bottom-composite", "bottom", bot, write));
  return out;
}

function compositeEntry(
  name: string,
  side: LayerSide,
  layers: Array<{ file: ClassifiedFile; parsed: ParsedGerber }>,
  write: (rel: string, bytes: Uint8Array | string) => string,
): LayerRender {
  const png = renderCompositePng(layers.map((l) => ({ parsed: l.parsed, kind: l.file.kind })));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 24"><text x="4" y="14" fill="#eee" font-size="6">${name}</text></svg>\n`;
  const bounds = layers.reduce((box, layer) => {
    const b = gerberBounds(layer.parsed, 0.4);
    return {
      minX: Math.min(box.minX, b.minX),
      minY: Math.min(box.minY, b.minY),
      maxX: Math.max(box.maxX, b.maxX),
      maxY: Math.max(box.maxY, b.maxY),
    };
  }, gerberBounds(layers[0]!.parsed, 0.4));
  return {
    layer: name,
    kind: "other",
    side,
    svg,
    svgPath: write(`${name}.svg`, svg),
    pngPath: write(`${name}.png`, png),
    bounds,
  };
}

function rgbaFromRaster(raster: Raster, r: number, g: number, b: number) {
  const data = new Uint8Array(raster.width * raster.height * 4);
  for (let i = 0; i < raster.data.length; i++) {
    const on = (raster.data[i] ?? 0) > 0;
    data[i * 4] = on ? r : 17;
    data[i * 4 + 1] = on ? g : 17;
    data[i * 4 + 2] = on ? b : 17;
    data[i * 4 + 3] = 255;
  }
  return { width: raster.width, height: raster.height, data };
}

function overlay(
  rgba: Uint8Array,
  rast: Raster,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  const a = alpha / 255;
  for (let i = 0; i < rast.data.length; i++) {
    if (!rast.data[i]) continue;
    const o = i * 4;
    rgba[o] = Math.round((rgba[o] ?? 17) * (1 - a) + r * a);
    rgba[o + 1] = Math.round((rgba[o + 1] ?? 17) * (1 - a) + g * a);
    rgba[o + 2] = Math.round((rgba[o + 2] ?? 17) * (1 - a) + b * a);
  }
}

function cssColor([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

function stemName(name: string): string {
  return name.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "") || "layer";
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
