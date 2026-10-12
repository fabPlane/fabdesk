import { sampleDarkness } from "./image";
import {
  MAX_PRIMITIVES,
  resolveArtOptions,
  type ArtOptions,
  type BoardArt,
  type GrayImage,
  type Primitive,
  type ResolvedArtOptions,
} from "./types";

export function convertImage(img: GrayImage, raw: ArtOptions): BoardArt {
  let options = resolveArtOptions(raw);
  let primitives = rasterize(img, options);
  let guard = 0;
  while (primitives.length > MAX_PRIMITIVES && guard < 8) {
    options = { ...options, pitchMm: options.pitchMm * 1.35 };
    primitives = rasterize(img, options);
    guard++;
  }
  if (primitives.length > MAX_PRIMITIVES) primitives = primitives.slice(0, MAX_PRIMITIVES);
  return { options, primitives, clipped: clipToOutline(primitives, options) };
}

function rasterize(img: GrayImage, o: ResolvedArtOptions): Primitive[] {
  if (o.style === "realistic") return halftone(img, o);
  if (o.style === "retro") return hatch(img, o);
  return threshold(img, o);
}

function sourceMap(img: GrayImage, o: ResolvedArtOptions): { sx: (x: number) => number; sy: (y: number) => number } {
  const box = artBox(o);
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const ox = box.x + (box.w - dw) / 2;
  const oy = box.y + (box.h - dh) / 2;
  return {
    sx: (x) => ((x - ox) / scale),
    sy: (y) => ((y - oy) / scale),
  };
}

function darknessAt(img: GrayImage, o: ResolvedArtOptions, map: ReturnType<typeof sourceMap>, x: number, y: number): number {
  const px = map.sx(x);
  const py = map.sy(y);
  if (px < -0.5 || py < -0.5 || px > img.width - 0.5 || py > img.height - 0.5) return 0;
  const d = sampleDarkness(img, px, py);
  return o.invert ? 1 - d : d;
}

function artBox(o: ResolvedArtOptions): { x: number; y: number; w: number; h: number } {
  return {
    x: o.marginMm,
    y: o.marginMm,
    w: o.widthMm - 2 * o.marginMm,
    h: o.heightMm - 2 * o.marginMm,
  };
}

/** Realistic: AM halftone dots. Darker source → larger printed dots. */
function halftone(img: GrayImage, o: ResolvedArtOptions): Primitive[] {
  const box = artBox(o);
  const map = sourceMap(img, o);
  const pitch = o.pitchMm;
  const cols = Math.max(1, Math.floor(box.w / pitch));
  const rows = Math.max(1, Math.floor(box.h / pitch));
  const out: Primitive[] = [];
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const x = box.x + (ix + 0.5) * pitch;
      const y = box.y + (iy + 0.5) * pitch;
      const d = darknessAt(img, o, map, x, y);
      const diameter = d * pitch * 0.92;
      if (diameter >= o.minFeatureMm) out.push({ kind: "circle", x, y, d: diameter });
    }
  }
  return out;
}

/** Retro: horizontal line hatch, run-length in dark regions. */
function hatch(img: GrayImage, o: ResolvedArtOptions): Primitive[] {
  const box = artBox(o);
  const map = sourceMap(img, o);
  const pitch = o.pitchMm;
  const rows = Math.max(1, Math.floor(box.h / pitch));
  const step = Math.max(o.minFeatureMm * 0.5, pitch / 4);
  const cutoff = Math.max(0.12, o.threshold * 0.5);
  const out: Primitive[] = [];
  for (let iy = 0; iy < rows; iy++) {
    const y = box.y + (iy + 0.5) * pitch;
    let runStart: number | null = null;
    let runDark = 0;
    let runN = 0;
    const flush = (xEnd: number) => {
      if (runStart === null) return;
      const x1 = runStart;
      const x2 = xEnd;
      if (x2 - x1 < o.minFeatureMm) {
        runStart = null;
        runDark = 0;
        runN = 0;
        return;
      }
      const avg = runN > 0 ? runDark / runN : 0;
      const w = Math.min(pitch * 0.85, Math.max(o.minFeatureMm, avg * pitch * 0.8));
      out.push({ kind: "line", x1, y1: y, x2, y2: y, w });
      runStart = null;
      runDark = 0;
      runN = 0;
    };
    for (let x = box.x; x <= box.x + box.w + 1e-9; x += step) {
      const d = darknessAt(img, o, map, x, y);
      if (d >= cutoff) {
        if (runStart === null) runStart = x;
        runDark += d;
        runN++;
      } else {
        flush(x);
      }
    }
    flush(box.x + box.w);
  }
  return out;
}

/** Poster: one clean cut — thresholded scanline rectangles. */
function threshold(img: GrayImage, o: ResolvedArtOptions): Primitive[] {
  const box = artBox(o);
  const map = sourceMap(img, o);
  const cell = Math.max(o.minFeatureMm, o.pitchMm);
  const cols = Math.max(1, Math.floor(box.w / cell));
  const rows = Math.max(1, Math.floor(box.h / cell));
  const out: Primitive[] = [];
  for (let iy = 0; iy < rows; iy++) {
    let run = 0;
    const flush = (ix: number) => {
      if (run === 0) return;
      out.push({
        kind: "rect",
        x: box.x + (ix - run) * cell,
        y: box.y + iy * cell,
        w: run * cell,
        h: cell,
      });
      run = 0;
    };
    for (let ix = 0; ix < cols; ix++) {
      const x = box.x + (ix + 0.5) * cell;
      const y = box.y + (iy + 0.5) * cell;
      if (darknessAt(img, o, map, x, y) >= o.threshold) run++;
      else flush(ix);
    }
    flush(cols);
  }
  return out;
}

export function pointInOutline(x: number, y: number, o: ResolvedArtOptions): boolean {
  if (o.outline === "circle") {
    const cx = o.widthMm / 2;
    const cy = o.heightMm / 2;
    const r = Math.min(o.widthMm, o.heightMm) / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1e-9;
  }
  if (o.outline === "rounded") {
    const r = Math.min(o.widthMm, o.heightMm) * 0.08;
    return roundedContains(x, y, o.widthMm, o.heightMm, r);
  }
  return x >= 0 && y >= 0 && x <= o.widthMm && y <= o.heightMm;
}

function roundedContains(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = x < r ? r : x > w - r ? w - r : x;
  const cy = y < r ? r : y > h - r ? h - r : y;
  if (cx === x || cy === y) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1e-9;
}

export function clipToOutline(primitives: readonly Primitive[], o: ResolvedArtOptions): Primitive[] {
  if (o.outline === "rectangle") return [...primitives];
  const out: Primitive[] = [];
  for (const p of primitives) {
    if (p.kind === "circle") {
      if (pointInOutline(p.x, p.y, o)) out.push(p);
    } else if (p.kind === "rect") {
      const samples = [
        [p.x + p.w / 2, p.y + p.h / 2],
        [p.x, p.y],
        [p.x + p.w, p.y + p.h],
      ];
      if (samples.every(([x, y]) => pointInOutline(x ?? 0, y ?? 0, o))) out.push(p);
    } else if (pointInOutline(p.x1, p.y1, o) && pointInOutline(p.x2, p.y2, o)) {
      out.push(p);
    }
  }
  return out;
}
