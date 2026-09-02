/**
 * Route Cinema renderer, ported from js_autorouter/tools/cinema/page.ts.
 *
 * The static board is drawn dimly, routed copper in layer colours, and the copper new since the
 * previous frame in white. Everything here except `drawScene` is pure so the frame bookkeeping can
 * be unit-tested without a canvas.
 */
import type { CinemaShape, RouteFrame, RouteFrameLine, RouteMeta, RouteResult } from "@fabdesk/protocol";

export interface CinemaRun {
  runId: string;
  meta: RouteMeta | null;
  statics: CinemaShape[];
  frames: RouteFrame[];
  result?: RouteResult;
}

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Transform {
  scale: number;
  ox: number;
  oy: number;
}

export const LAYER_COLORS = [
  "#e5484d",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#a855f7",
  "#14b8a6",
  "#f97316",
  "#64748b",
  "#ec4899",
  "#84cc16",
  "#06b6d4",
  "#f43f5e",
] as const;

export const NEW_COPPER_COLOR = "#ffffff";
export const PAD_COLOR = "#8a929e";
export const KEEPOUT_COLOR = "#7c3aed";

export interface Theme {
  background: string;
  outline: string;
}

export const DARK_THEME: Theme = { background: "#14161a", outline: "#3a3f47" };
export const LIGHT_THEME: Theme = { background: "#f4f5f7", outline: "#b8bcc4" };

export function emptyRun(runId: string): CinemaRun {
  return { runId, meta: null, statics: [], frames: [] };
}

export function layerColor(layer: number): string {
  const n = LAYER_COLORS.length;
  return LAYER_COLORS[((layer % n) + n) % n] ?? LAYER_COLORS[0];
}

/** Applies a frame-protocol line to a run. Frames are kept in `seq` order; duplicates are dropped. */
export function applyLine(run: CinemaRun, line: RouteFrameLine): CinemaRun {
  if (line.runId !== run.runId) return run;
  switch (line.kind) {
    case "meta":
      return { ...run, meta: line };
    case "static":
      return { ...run, statics: line.shapes };
    case "frame": {
      const last = run.frames[run.frames.length - 1];
      if (last && line.seq <= last.seq) {
        if (run.frames.some((f) => f.seq === line.seq)) return run;
        const frames = [...run.frames, line].sort((a, b) => a.seq - b.seq);
        return { ...run, frames };
      }
      return { ...run, frames: [...run.frames, line] };
    }
    default:
      return run;
  }
}

export function applyLines(run: CinemaRun, lines: readonly RouteFrameLine[]): CinemaRun {
  let out = run;
  for (const line of lines) out = applyLine(out, line);
  return out;
}

/** Highest frame `seq` seen, for `/route/runs/:id/frames?from=`. */
export function nextFrameSeq(run: CinemaRun): number {
  const last = run.frames[run.frames.length - 1];
  return last ? last.seq + 1 : 0;
}

/** Bounds from meta, or derived from shapes when meta is missing. */
export function computeBounds(run: CinemaRun): Bounds | null {
  if (run.meta) return run.meta.bounds;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const visit = (s: CinemaShape) => {
    for (let i = 0; i + 1 < s.pts.length; i += 2) {
      const x = s.pts[i] ?? 0;
      const y = s.pts[i + 1] ?? 0;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  };
  run.statics.forEach(visit);
  const last = run.frames[run.frames.length - 1];
  last?.shapes.forEach(visit);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || x1 === x2 || y1 === y2) return null;
  return { x1, y1, x2, y2 };
}

/** Board y up → canvas y down, 94% fit, centred. */
export function computeTransform(bounds: Bounds, width: number, height: number, margin = 0.94): Transform {
  const bw = bounds.x2 - bounds.x1 || 1;
  const bh = bounds.y2 - bounds.y1 || 1;
  const scale = margin * Math.min(width / bw, height / bh);
  const ox = (width - bw * scale) / 2 - bounds.x1 * scale;
  const oy = (height + bh * scale) / 2 + bounds.y1 * scale;
  return { scale, ox, oy };
}

export function toCanvas(t: Transform, x: number, y: number): [number, number] {
  return [x * t.scale + t.ox, t.oy - y * t.scale];
}

/** Shapes in `current` whose ids do not appear in `previous` (the copper drawn in white). */
export function newShapeIds(previous: readonly CinemaShape[] | undefined, current: readonly CinemaShape[]): Set<number> {
  const prevIds = new Set<number>();
  if (previous) for (const s of previous) prevIds.add(s.id);
  const out = new Set<number>();
  for (const s of current) if (!prevIds.has(s.id)) out.add(s.id);
  return out;
}

export function frameStatusText(run: CinemaRun, cursor: number): string {
  if (cursor < 0 || run.frames.length === 0) return run.meta ? "waiting for frames…" : "no routing run yet";
  const frame = run.frames[cursor];
  if (!frame) return "";
  const e = frame.event;
  const parts = [`frame ${cursor + 1}/${run.frames.length}`];
  let desc = e.kind;
  if (e.passNo !== undefined) desc += ` pass ${e.passNo}`;
  if (e.netNumber !== undefined) desc += ` net ${e.netNumber}`;
  if (e.status) desc += ` → ${e.status}`;
  if (e.kind === "pair") desc += e.coupled ? " coupled" : " uncoupled";
  parts.push(desc);
  parts.push(`${(frame.elapsedMs / 1000).toFixed(1)}s`);
  if (run.result && cursor === run.frames.length - 1) {
    parts.push(`done: ${run.result.complete.length} routed, ${run.result.open.length} open`);
  }
  return parts.join("  ·  ");
}

export interface DrawOptions {
  run: CinemaRun;
  cursor: number;
  hiddenLayers: ReadonlySet<number>;
  width: number;
  height: number;
  theme?: Theme;
}

export interface Canvas2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
}

function drawShape(
  ctx: Canvas2D,
  s: CinemaShape,
  t: Transform,
  hidden: ReadonlySet<number>,
  color: string,
  alpha: number,
): void {
  // Vias and other through-items carry layer -1 and stay visible whatever is toggled.
  if (s.layer >= 0 && hidden.has(s.layer)) return;
  ctx.globalAlpha = alpha;
  if (s.k === "trace") {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, (s.w ?? 0) * t.scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i + 1 < s.pts.length; i += 2) {
      const [x, y] = toCanvas(t, s.pts[i] ?? 0, s.pts[i + 1] ?? 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else {
    const [x1, y1] = toCanvas(t, s.pts[0] ?? 0, s.pts[1] ?? 0);
    const [x2, y2] = toCanvas(t, s.pts[2] ?? 0, s.pts[3] ?? 0);
    if (s.k === "via") {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, Math.max(2, Math.abs(x2 - x1) / 2), 0, Math.PI * 2);
      ctx.fill();
    } else if (s.k === "keepout") {
      ctx.strokeStyle = KEEPOUT_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
    }
  }
  ctx.globalAlpha = 1;
}

/** Draws the whole scene for the frame at `cursor`. Returns the transform used (null when nothing drawn). */
export function drawScene(ctx: Canvas2D, opts: DrawOptions): Transform | null {
  const theme = opts.theme ?? DARK_THEME;
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, opts.width, opts.height);
  const bounds = computeBounds(opts.run);
  if (!bounds) return null;
  const t = computeTransform(bounds, opts.width, opts.height);
  ctx.strokeStyle = theme.outline;
  ctx.lineWidth = 1;
  const [bx, by] = toCanvas(t, bounds.x1, bounds.y2);
  ctx.strokeRect(bx, by, (bounds.x2 - bounds.x1) * t.scale, (bounds.y2 - bounds.y1) * t.scale);

  for (const s of opts.run.statics) {
    drawShape(ctx, s, t, opts.hiddenLayers, s.k === "pad" ? PAD_COLOR : layerColor(s.layer), s.k === "trace" ? 0.35 : 0.5);
  }
  if (opts.cursor < 0) return t;
  const frame = opts.run.frames[opts.cursor];
  if (!frame) return t;
  const fresh = newShapeIds(opts.cursor > 0 ? opts.run.frames[opts.cursor - 1]?.shapes : undefined, frame.shapes);
  for (const s of frame.shapes) {
    const isNew = fresh.has(s.id);
    drawShape(ctx, s, t, opts.hiddenLayers, isNew ? NEW_COPPER_COLOR : layerColor(s.layer), isNew ? 1 : 0.9);
  }
  return t;
}
