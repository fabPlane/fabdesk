import {
  arrowHead,
  MARK_COLOR,
  MARK_HALO,
  MARK_HALO_WIDTH,
  MARK_WIDTH,
  type MarkupPoint,
  type MarkupStroke,
} from "./strokes";

export { MARK_COLOR, MARK_HALO, MARK_HALO_WIDTH, MARK_WIDTH } from "./strokes";

export const MAX_PNG_EDGE = 1600;

export type CompositeSize = { width: number; height: number; scale: number };

/** CSS overlay size × device pixel ratio, capped so the agent image stays small. */
export function compositeSize(cssWidth: number, cssHeight: number, dpr: number, maxEdge = MAX_PNG_EDGE): CompositeSize {
  const w = Math.max(1, Math.round(cssWidth));
  const h = Math.max(1, Math.round(cssHeight));
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
  let width = Math.max(1, Math.round(w * ratio));
  let height = Math.max(1, Math.round(h * ratio));
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const fit = maxEdge / longest;
    width = Math.max(1, Math.round(width * fit));
    height = Math.max(1, Math.round(height * fit));
  }
  return { width, height, scale: width / w };
}

export interface StrokeSink {
  polyline(points: MarkupPoint[], color: string, width: number): void;
  polygon(points: MarkupPoint[], color: string): void;
}

export function paintStrokes(sink: StrokeSink, strokes: readonly MarkupStroke[], scale = 1): void {
  const map = (p: MarkupPoint): MarkupPoint => ({ x: p.x * scale, y: p.y * scale });
  for (const stroke of strokes) {
    if (stroke.tool === "pen") {
      if (stroke.points.length === 0) continue;
      const pts = stroke.points.map(map);
      const line = pts.length === 1 ? [pts[0]!, pts[0]!] : pts;
      sink.polyline(line, MARK_HALO, MARK_HALO_WIDTH * scale);
      sink.polyline(line, MARK_COLOR, MARK_WIDTH * scale);
    } else {
      const from = map(stroke.from);
      const to = map(stroke.to);
      sink.polyline([from, to], MARK_HALO, MARK_HALO_WIDTH * scale);
      sink.polyline([from, to], MARK_COLOR, MARK_WIDTH * scale);
      const head = arrowHead(from, to, 14 * scale);
      sink.polygon(head, MARK_HALO);
      sink.polygon(arrowHead(from, to, 12 * scale), MARK_COLOR);
    }
  }
}

type Canvas2D = {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

export function drawStrokesOnCanvas(ctx: Canvas2D, strokes: readonly MarkupStroke[], scale = 1): void {
  paintStrokes(
    {
      polyline(points, color, width) {
        if (points.length === 0) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
        ctx.stroke();
        ctx.restore();
      },
      polygon(points, color) {
        if (points.length < 3) return;
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      },
    },
    strokes,
    scale,
  );
}

const MARK_RGB = hexRgb(MARK_COLOR);

/** Software rasterizer so tests can assert mark pixels without a browser canvas. */
export function rasterizeStrokes(
  width: number,
  height: number,
  strokes: readonly MarkupStroke[],
  scale = 1,
  background: [number, number, number, number] = [20, 22, 26, 255],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = background[0];
    data[i + 1] = background[1];
    data[i + 2] = background[2];
    data[i + 3] = background[3];
  }
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const i = (py * width + px) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const disk = (cx: number, cy: number, radius: number, r: number, g: number, b: number) => {
    const rad = Math.max(0.6, radius);
    const minX = Math.floor(cx - rad);
    const maxX = Math.ceil(cx + rad);
    const minY = Math.floor(cy - rad);
    const maxY = Math.ceil(cy + rad);
    const r2 = rad * rad;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) put(x, y, r, g, b);
      }
    }
  };
  const line = (a: MarkupPoint, b: MarkupPoint, widthPx: number, r: number, g: number, bl: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      disk(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, widthPx / 2, r, g, bl);
    }
  };
  const fillPoly = (pts: MarkupPoint[], r: number, g: number, b: number) => {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.floor(Math.min(...xs));
    const maxX = Math.ceil(Math.max(...xs));
    const minY = Math.floor(Math.min(...ys));
    const maxY = Math.ceil(Math.max(...ys));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (pointInPoly(x + 0.5, y + 0.5, pts)) put(x, y, r, g, b);
      }
    }
  };
  paintStrokes(
    {
      polyline(points, color, width) {
        const rgb = color === MARK_COLOR ? MARK_RGB : hexRgb(color);
        for (let i = 1; i < points.length; i++) line(points[i - 1]!, points[i]!, width, rgb[0], rgb[1], rgb[2]);
        if (points.length === 1) disk(points[0]!.x, points[0]!.y, width / 2, rgb[0], rgb[1], rgb[2]);
      },
      polygon(points, color) {
        const rgb = color === MARK_COLOR ? MARK_RGB : hexRgb(color);
        fillPoly(points, rgb[0], rgb[1], rgb[2]);
      },
    },
    strokes,
    scale,
  );
  return data;
}

export function sampleMark(data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number, number] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
}

function pointInPoly(x: number, y: number, pts: MarkupPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const pi = pts[i]!;
    const pj = pts[j]!;
    const intersect = pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / ((pj.y - pi.y) || 1e-9) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hexRgb(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  const v = Number.parseInt(n.length === 3 ? n.split("").map((c) => c + c).join("") : n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
