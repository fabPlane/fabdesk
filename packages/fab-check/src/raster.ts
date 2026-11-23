import type { GerberAperture, ParsedGerber } from "@fabdesk/board-art";
import { emptyRect, expand, padRect, validRect } from "./geometry";
import type { Rect } from "./types";

export type Raster = {
  width: number;
  height: number;
  /** 0 = empty, >0 = paint (component id after labeling). */
  data: Uint16Array;
  originX: number;
  originY: number;
  scale: number;
};

export function gerberBounds(parsed: ParsedGerber, padMm = 0.4): Rect {
  const box = emptyRect();
  const byId = new Map(parsed.apertures.map((a) => [a.id, a]));
  for (const op of parsed.ops) {
    if (op.op === "flash") {
      const r = apertureRadius(byId.get(op.aperture));
      expand(box, op.x - r, op.y - r);
      expand(box, op.x + r, op.y + r);
    } else if (op.op === "draw") {
      const r = apertureRadius(byId.get(op.aperture));
      expand(box, op.x1 - r, op.y1 - r);
      expand(box, op.x1 + r, op.y1 + r);
      expand(box, op.x2 - r, op.y2 - r);
      expand(box, op.x2 + r, op.y2 + r);
    } else {
      for (const p of op.points) expand(box, p.x, p.y);
    }
  }
  return validRect(box) ? padRect(box, padMm) : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

export function rasterizeGerber(
  parsed: ParsedGerber,
  opts: { scale?: number; maxPx?: number; bounds?: Rect } = {},
): Raster {
  const bounds = opts.bounds ?? gerberBounds(parsed);
  const widthMm = Math.max(0.5, bounds.maxX - bounds.minX);
  const heightMm = Math.max(0.5, bounds.maxY - bounds.minY);
  let scale = opts.scale ?? 40;
  const maxPx = opts.maxPx ?? 1600;
  if (widthMm * scale > maxPx) scale = maxPx / widthMm;
  if (heightMm * scale > maxPx) scale = maxPx / heightMm;
  scale = Math.max(8, scale);
  const width = Math.max(2, Math.ceil(widthMm * scale) + 2);
  const height = Math.max(2, Math.ceil(heightMm * scale) + 2);
  const data = new Uint16Array(width * height);
  const raster: Raster = {
    width,
    height,
    data,
    originX: bounds.minX,
    originY: bounds.minY,
    scale,
  };
  const byId = new Map(parsed.apertures.map((a) => [a.id, a]));
  for (const op of parsed.ops) {
    if (op.op === "flash") paintAperture(raster, byId.get(op.aperture), op.x, op.y);
    else if (op.op === "draw")
      paintDraw(raster, byId.get(op.aperture), op.x1, op.y1, op.x2, op.y2);
    else paintRegion(raster, op.points);
  }
  return raster;
}

export function toPixel(raster: Raster, x: number, y: number): { px: number; py: number } {
  return {
    px: Math.round((x - raster.originX) * raster.scale),
    py: Math.round((y - raster.originY) * raster.scale),
  };
}

export function fromPixel(raster: Raster, px: number, py: number): { x: number; y: number } {
  return {
    x: raster.originX + px / raster.scale,
    y: raster.originY + py / raster.scale,
  };
}

export function labelComponents(raster: Raster): number {
  const { width, height, data } = raster;
  let next = 1;
  const stack: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 1) continue;
    next += 1;
    const id = next;
    stack.push(i);
    while (stack.length) {
      const idx = stack.pop()!;
      if (data[idx] !== 1) continue;
      data[idx] = id;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0) stack.push(idx - 1);
      if (x + 1 < width) stack.push(idx + 1);
      if (y > 0) stack.push(idx - width);
      if (y + 1 < height) stack.push(idx + width);
    }
  }
  return next - 1;
}

function apertureRadius(ap: GerberAperture | undefined): number {
  if (!ap) return 0.05;
  if (ap.kind === "C") return ap.d / 2;
  return Math.max(ap.w, ap.h) / 2;
}

function paintAperture(raster: Raster, ap: GerberAperture | undefined, x: number, y: number): void {
  if (!ap) {
    stampCircle(raster, x, y, 0.05);
    return;
  }
  if (ap.kind === "C") stampCircle(raster, x, y, ap.d / 2);
  else stampRect(raster, x, y, ap.w, ap.h, ap.kind === "O");
}

function paintDraw(
  raster: Raster,
  ap: GerberAperture | undefined,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const r = apertureRadius(ap);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(len * raster.scale));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampCircle(raster, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, r);
  }
}

function paintRegion(raster: Raster, points: Array<{ x: number; y: number }>): void {
  if (points.length < 3) return;
  const ys = points.map((p) => toPixel(raster, p.x, p.y).py);
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(raster.height - 1, Math.max(...ys));
  for (let py = minY; py <= maxY; py++) {
    const y = raster.originY + (py + 0.5) / raster.scale;
    const xs: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i]!;
      const b = points[j]!;
      if ((a.y > y) !== (b.y > y)) {
        xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y + 1e-15) + a.x);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = toPixel(raster, xs[k]!, y).px;
      const x1 = toPixel(raster, xs[k + 1]!, y).px;
      const lo = Math.max(0, Math.min(x0, x1));
      const hi = Math.min(raster.width - 1, Math.max(x0, x1));
      for (let px = lo; px <= hi; px++) raster.data[py * raster.width + px] = 1;
    }
  }
}

function stampCircle(raster: Raster, x: number, y: number, r: number): void {
  const { px, py } = toPixel(raster, x, y);
  const rad = Math.max(1, Math.round(r * raster.scale));
  const r2 = rad * rad;
  for (let dy = -rad; dy <= rad; dy++) {
    const yy = py + dy;
    if (yy < 0 || yy >= raster.height) continue;
    for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const xx = px + dx;
      if (xx < 0 || xx >= raster.width) continue;
      raster.data[yy * raster.width + xx] = 1;
    }
  }
}

function stampRect(
  raster: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  oval: boolean,
): void {
  if (oval) {
    const { px, py } = toPixel(raster, x, y);
    const rx = Math.max(1, Math.round((w / 2) * raster.scale));
    const ry = Math.max(1, Math.round((h / 2) * raster.scale));
    for (let dy = -ry; dy <= ry; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= raster.height) continue;
      for (let dx = -rx; dx <= rx; dx++) {
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue;
        const xx = px + dx;
        if (xx < 0 || xx >= raster.width) continue;
        raster.data[yy * raster.width + xx] = 1;
      }
    }
    return;
  }
  const x0 = x - w / 2;
  const y0 = y - h / 2;
  const a = toPixel(raster, x0, y0);
  const b = toPixel(raster, x0 + w, y0 + h);
  const minX = Math.max(0, Math.min(a.px, b.px));
  const maxX = Math.min(raster.width - 1, Math.max(a.px, b.px));
  const minY = Math.max(0, Math.min(a.py, b.py));
  const maxY = Math.min(raster.height - 1, Math.max(a.py, b.py));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) raster.data[py * raster.width + px] = 1;
  }
}
