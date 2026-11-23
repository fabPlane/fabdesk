/**
 * Route Cinema renderer for visualizing routing frames.
 *
 * The static board is drawn dimly, routed copper in layer colours, and the copper new since the
 * previous frame in white. Everything here except `drawScene` is pure so the frame bookkeeping can
 * be unit-tested without a canvas.
 *
 * Lives in client-core rather than the desktop UI because the drawing is pure maths over the
 * `Canvas2D` interface below: the desktop hands it a `CanvasRenderingContext2D`, the phone a Skia
 * adapter (`apps/mobile/src/components/CinemaSkia.ts`). Nothing here may touch the DOM.
 */
import type { CinemaShape, RouteFrame, RouteFrameLine, RouteMeta, RouteResult } from "@fabdesk/protocol";

export interface CinemaRun {
  runId: string;
  meta: RouteMeta | null;
  statics: CinemaShape[];
  frames: RouteFrame[];
  result?: RouteResult;
  /** Frames dropped from `frames` by the store's retention cap (they still count for numbering). */
  evicted?: number;
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
  newCopper?: string;
}

export const DARK_THEME: Theme = { background: "#14161a", outline: "#3a3f47" };
export const LIGHT_THEME: Theme = { background: "#f1f0e9", outline: "#c4c6bd", newCopper: "#006b55" };

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

export function fromCanvas(t: Transform, cx: number, cy: number): [number, number] {
  return [(cx - t.ox) / t.scale, (t.oy - cy) / t.scale];
}

/** Shapes in `current` whose ids do not appear in `previous` (the copper drawn in white). */
export function newShapeIds(previous: readonly CinemaShape[] | undefined, current: readonly CinemaShape[]): Set<number> {
  const prevIds = new Set<number>();
  if (previous) for (const s of previous) prevIds.add(s.id);
  const out = new Set<number>();
  for (const s of current) if (!prevIds.has(s.id)) out.add(s.id);
  return out;
}

export interface PerfReadout {
  fps: number;
  drawMs: number;
  dropped: number;
}

/** `12.3 f/s · draw 4.1 ms · 7 dropped` (omitting zero parts). */
export function perfStatusText(perf: PerfReadout, shapes?: number): string {
  const parts: string[] = [];
  if (perf.fps > 0) parts.push(`${perf.fps.toFixed(perf.fps >= 10 ? 0 : 1)} f/s`);
  if (perf.drawMs > 0) parts.push(`draw ${perf.drawMs.toFixed(1)} ms`);
  if (shapes !== undefined && shapes > 0) parts.push(`${shapes} shapes`);
  if (perf.dropped > 0) parts.push(`${perf.dropped} dropped`);
  return parts.join(" · ");
}

export function frameStatusText(run: CinemaRun, cursor: number): string {
  if (cursor < 0 || run.frames.length === 0) return run.meta ? "waiting for frames…" : "no routing run yet";
  const frame = run.frames[cursor];
  if (!frame) return "";
  const e = frame.event;
  const evicted = run.evicted ?? 0;
  const parts = [evicted > 0 ? `frame ${frame.seq}/${run.frames[run.frames.length - 1]!.seq} (${run.frames.length} kept)` : `frame ${cursor + 1}/${run.frames.length}`];
  let desc = e.kind;
  if (e.passNo !== undefined) desc += ` pass ${e.passNo}`;
  if (e.netNumber !== undefined) desc += ` net ${e.netNumber}`;
  if (e.status) desc += ` → ${e.status}`;
  if (e.kind === "pair") desc += e.coupled ? " coupled" : " uncoupled";
  parts.push(desc);
  parts.push(`${(frame.elapsedMs / 1000).toFixed(1)}s`);
  if (run.result && cursor === run.frames.length - 1) {
    const { complete, open, stats } = run.result;
    parts.push(
      `done: ${complete.length}/${complete.length + open.length} routed, ${open.length} open, ${stats.vias} vias, ${stats.segments} segments`,
    );
  }
  return parts.join("  ·  ");
}

export type CinemaView = "board" | "activity";

export interface DrawOptions {
  run: CinemaRun;
  cursor: number;
  hiddenLayers: ReadonlySet<number>;
  width: number;
  height: number;
  theme?: Theme;
  /** `activity` zooms to the copper routed in the last few frames; `board` fits the whole board. */
  view?: CinemaView;
  /** Dim the static board so the router's own copper dominates (default: on while a frame is shown). */
  focus?: boolean;
}

export const RECENT_WINDOW = 6;
export const RECENT_COPPER_COLOR = "#ffd166";
export const AIRLINE_COLOR = "#facc15";

/**
 * Age of each shape in the frame at `cursor`: 0 = new in this frame, 1 = new in the previous one, …
 * up to `window`. Shapes older than the window are absent (they are settled copper).
 */
export function recentShapeAges(run: CinemaRun, cursor: number, window = RECENT_WINDOW): Map<number, number> {
  const ages = new Map<number, number>();
  const current = cursor >= 0 ? run.frames[cursor] : undefined;
  if (!current) return ages;
  const present = new Set(current.shapes.map((s) => s.id));
  for (let age = 0; age <= window; age += 1) {
    const idx = cursor - age;
    if (idx < 0) break;
    const frame = run.frames[idx];
    const older = idx > 0 ? run.frames[idx - 1]?.shapes : undefined;
    if (!frame) break;
    for (const id of newShapeIds(older, frame.shapes)) if (present.has(id) && !ages.has(id)) ages.set(id, age);
  }
  return ages;
}

/**
 * View window for `activity`: the copper added in the last frames plus the current airline, padded
 * and no smaller than `minSizeMm`, quantised so the view only moves when the work moves. Falls back
 * to all router copper, then to the board.
 */
export function activityBounds(run: CinemaRun, cursor: number, board: Bounds, opts?: { minSizeMm?: number; padding?: number; window?: number }): Bounds {
  const frame = cursor >= 0 ? run.frames[cursor] : undefined;
  if (!frame) return board;
  const upm = run.meta?.unitsPerMm ?? 1;
  const ages = recentShapeAges(run, cursor, opts?.window ?? RECENT_WINDOW);
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const visit = (x: number, y: number) => {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  };
  const copper = frame.shapes.filter(isRouterCopper);
  const shapes = ages.size > 0 ? copper.filter((s) => ages.has(s.id)) : copper;
  for (const s of shapes) for (let i = 0; i + 1 < s.pts.length; i += 2) visit(s.pts[i] ?? 0, s.pts[i + 1] ?? 0);
  const air = frame.event.airline;
  if (air) {
    visit(air.from.x, air.from.y);
    visit(air.to.x, air.to.y);
  }
  if (!Number.isFinite(x1) || !Number.isFinite(y1)) return board;
  const minSize = (opts?.minSizeMm ?? 14) * upm;
  const pad = 1 + (opts?.padding ?? 0.25);
  const q = 2 * upm; // quantise the window to 2 mm steps
  const w = Math.max(minSize, (x2 - x1) * pad);
  const h = Math.max(minSize, (y2 - y1) * pad);
  const cx = Math.round((x1 + x2) / 2 / q) * q;
  const cy = Math.round((y1 + y2) / 2 / q) * q;
  const bw = board.x2 - board.x1;
  const bh = board.y2 - board.y1;
  if (w >= bw && h >= bh) return board;
  const clamp = (lo: number, size: number, blo: number, bhi: number) => {
    if (size >= bhi - blo) return [blo, bhi] as const;
    const start = Math.min(Math.max(lo, blo), bhi - size);
    return [start, start + size] as const;
  };
  const [ax1, ax2] = clamp(cx - w / 2, w, board.x1, board.x2);
  const [ay1, ay2] = clamp(cy - h / 2, h, board.y1, board.y2);
  return { x1: ax1, y1: ay1, x2: ax2, y2: ay2 };
}

export type LineCap = "butt" | "round" | "square";
export type LineJoin = "miter" | "round" | "bevel";

/**
 * The slice of `CanvasRenderingContext2D` the painter uses, with colours as CSS strings only (it
 * never sets gradients or patterns) so a non-DOM backend has a small contract to satisfy.
 */
export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  setLineDash?(segments: number[]): void;
}

function drawShape(
  ctx: Canvas2D,
  s: CinemaShape,
  t: Transform,
  hidden: ReadonlySet<number>,
  color: string,
  alpha: number,
  minLineWidth = 1,
): void {
  // Vias and other through-items carry layer -1 and stay visible whatever is toggled.
  if (s.layer >= 0 && hidden.has(s.layer)) return;
  ctx.globalAlpha = alpha;
  if (s.k === "trace") {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(minLineWidth, (s.w ?? 0) * t.scale);
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
    } else if (s.k === "area") {
      // Pour fragments; `drawStatics` paints them opaque and veils them once, since thousands of
      // overlapping translucent boxes would stack to a solid colour.
      ctx.fillStyle = color;
      ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
    }
  }
  ctx.globalAlpha = 1;
}


/** Static draw order: pours/areas first, then keepouts, copper and pads on top. */
function orderedStatics(statics: readonly CinemaShape[]): CinemaShape[] {
  const rank = (s: CinemaShape) => (s.k === "area" ? 0 : s.k === "keepout" ? 1 : s.k === "trace" ? 2 : s.k === "via" ? 3 : 4);
  return [...statics].sort((a, b) => rank(a) - rank(b));
}

/** Draws the static board (outline, pads, keepouts, pre-routed copper) onto `ctx`. */
export function drawStatics(ctx: Canvas2D, run: CinemaRun, t: Transform, hidden: ReadonlySet<number>, bounds: Bounds, width: number, height: number, theme: Theme, dim = false): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.outline;
  ctx.lineWidth = 1;
  const board = run.meta?.bounds ?? bounds;
  const [bx, by] = toCanvas(t, board.x1, board.y2);
  ctx.strokeRect(bx, by, (board.x2 - board.x1) * t.scale, (board.y2 - board.y1) * t.scale);
  // Pours: paint every fragment opaque, then veil the lot with the background so their union is one
  // faint tint (a 20k-vertex GND pour arrives as thousands of overlapping boxes).
  const ordered = orderedStatics(run.statics);
  let i = 0;
  for (; i < ordered.length && ordered[i]!.k === "area"; i += 1) drawShape(ctx, ordered[i]!, t, hidden, layerColor(ordered[i]!.layer), 1);
  if (i > 0) {
    ctx.globalAlpha = dim ? 0.96 : 0.9;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.outline;
    ctx.strokeRect(bx, by, (board.x2 - board.x1) * t.scale, (board.y2 - board.y1) * t.scale);
  }
  // While routing, the existing board is context: pull it back so the router's copper reads first.
  const k = dim ? 0.38 : 1;
  for (; i < ordered.length; i += 1) {
    const s = ordered[i]!;
    drawShape(ctx, s, t, hidden, s.k === "pad" ? PAD_COLOR : layerColor(s.layer), (s.k === "trace" ? 0.35 : 0.5) * k);
  }
}

/** Dashed rubber band between the two pads the router is joining right now, with endpoint dots. */
export function drawAirline(ctx: Canvas2D, frame: RouteFrame, t: Transform): void {
  const air = frame.event.airline;
  if (!air) return;
  const [x1, y1] = toCanvas(t, air.from.x, air.from.y);
  const [x2, y2] = toCanvas(t, air.to.x, air.to.y);
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = AIRLINE_COLOR;
  ctx.fillStyle = AIRLINE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.setLineDash?.([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash?.([]);
  for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Recently added copper: this frame's in the theme highlight with a glow, the last few frames' in amber, fading. */
export function drawRecent(ctx: Canvas2D, shapes: readonly CinemaShape[], ages: ReadonlyMap<number, number>, t: Transform, hidden: ReadonlySet<number>, window = RECENT_WINDOW, newCopper = NEW_COPPER_COLOR): void {
  for (const s of shapes) {
    if (!isRouterCopper(s)) continue;
    const age = ages.get(s.id);
    if (age === undefined) continue;
    if (age === 0) {
      drawShape(ctx, s, t, hidden, newCopper, 0.35, 7);
      drawShape(ctx, s, t, hidden, newCopper, 1, 2.5);
    } else {
      drawShape(ctx, s, t, hidden, RECENT_COPPER_COLOR, Math.max(0.45, 1 - age / (window + 1)), 2.5);
    }
  }
}

/** Router output worth animating: traces and vias. Pours/keepouts re-emitted by the router are static context. */
export function isRouterCopper(s: CinemaShape): boolean {
  return s.k === "trace" || s.k === "via";
}

/** Draws routed copper shapes in layer colours (the settled copper layer). */
export function drawCopper(ctx: Canvas2D, shapes: readonly CinemaShape[], t: Transform, hidden: ReadonlySet<number>): void {
  for (const s of shapes) if (isRouterCopper(s)) drawShape(ctx, s, t, hidden, layerColor(s.layer), 1, 2);
}

/** Draws the copper new in this frame in white on top. */
export function drawFresh(ctx: Canvas2D, shapes: readonly CinemaShape[], fresh: ReadonlySet<number>, t: Transform, hidden: ReadonlySet<number>): void {
  for (const s of shapes) if (fresh.has(s.id)) drawShape(ctx, s, t, hidden, NEW_COPPER_COLOR, 1);
}

/**
 * True when `current` only adds shapes to `previous` (same ids kept, same geometry assumed):
 * the live-follow case, where the copper layer can be extended instead of redrawn.
 */
export function isSuperset(previous: readonly CinemaShape[] | undefined, current: readonly CinemaShape[]): boolean {
  if (!previous) return false;
  if (current.length < previous.length) return false;
  const ids = new Set<number>();
  for (const s of current) ids.add(s.id);
  for (const s of previous) if (!ids.has(s.id)) return false;
  return true;
}

export interface OffscreenLike extends Canvas2D {
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, x: number, y: number): void;
}

export interface PainterCanvases {
  /** Static board layer; drawn once per size/transform/layer-visibility/theme change. */
  statics: OffscreenLike;
  /** Settled copper; extended incrementally while following live, rebuilt on seeks. */
  copper: OffscreenLike;
  /** Handle passed to `drawImage` for each offscreen canvas. */
  image: (which: "statics" | "copper") => unknown;
}

/**
 * Incremental Route Cinema painter. `paint()` composes three layers onto the visible context:
 * cached statics, cached copper (extended by the frame delta when the new frame is a superset
 * of the previous one, else rebuilt) and the fresh copper highlight. Returns draw statistics.
 */
export class CinemaPainter {
  #staticsKey = "";
  #copperKey = "";
  #copperFrameIndex = -1;
  #copperIds = new Set<number>();

  constructor(private readonly canvases: PainterCanvases) {}

  invalidate(): void {
    this.#staticsKey = "";
    this.#copperKey = "";
    this.#copperFrameIndex = -1;
  }

  paint(ctx: OffscreenLike, opts: DrawOptions): { transform: Transform | null; shapes: number; staticsRedrawn: boolean; copperRedrawn: boolean; copperExtended: number } {
    const theme = opts.theme ?? DARK_THEME;
    const bounds = computeBounds(opts.run);
    ctx.globalAlpha = 1;
    if (!bounds) {
      ctx.fillStyle = theme.background;
      ctx.fillRect(0, 0, opts.width, opts.height);
      return { transform: null, shapes: 0, staticsRedrawn: false, copperRedrawn: false, copperExtended: 0 };
    }
    const frameShown = opts.cursor >= 0 && opts.run.frames[opts.cursor] !== undefined;
    const focus = opts.focus ?? frameShown;
    const view = opts.view === "activity" && frameShown ? activityBounds(opts.run, opts.cursor, bounds) : bounds;
    const t = computeTransform(view, opts.width, opts.height);
    const hiddenKey = [...opts.hiddenLayers].sort().join(",");
    const staticsKey = `${opts.run.runId}|${opts.width}x${opts.height}|${t.scale}|${t.ox},${t.oy}|${hiddenKey}|${theme.background}|${opts.run.statics.length}|${focus}`;
    let staticsRedrawn = false;
    if (staticsKey !== this.#staticsKey) {
      drawStatics(this.canvases.statics, opts.run, t, opts.hiddenLayers, view, opts.width, opts.height, theme, focus);
      this.#staticsKey = staticsKey;
      staticsRedrawn = true;
    }
    ctx.clearRect(0, 0, opts.width, opts.height);
    ctx.drawImage(this.canvases.image("statics"), 0, 0);
    const frame = opts.cursor >= 0 ? opts.run.frames[opts.cursor] : undefined;
    if (!frame) {
      this.#copperKey = "";
      return { transform: t, shapes: 0, staticsRedrawn, copperRedrawn: false, copperExtended: 0 };
    }
    const copperKey = `${staticsKey}|${opts.run.runId}`;
    const previous = opts.cursor > 0 ? opts.run.frames[opts.cursor - 1]?.shapes : undefined;
    let copperRedrawn = false;
    let copperExtended = 0;
    const sequential = copperKey === this.#copperKey && this.#copperFrameIndex === opts.cursor - 1 && staticsRedrawn === false;
    if (sequential && isSuperset(previous, frame.shapes)) {
      // Live follow: only the shapes that are new since the last painted frame go onto the copper layer.
      const delta = frame.shapes.filter((s) => !this.#copperIds.has(s.id));
      drawCopper(this.canvases.copper, delta, t, opts.hiddenLayers);
      for (const s of delta) this.#copperIds.add(s.id);
      copperExtended = delta.length;
    } else if (copperKey !== this.#copperKey || this.#copperFrameIndex !== opts.cursor) {
      this.canvases.copper.clearRect(0, 0, opts.width, opts.height);
      drawCopper(this.canvases.copper, frame.shapes, t, opts.hiddenLayers);
      this.#copperIds = new Set(frame.shapes.map((s) => s.id));
      copperRedrawn = true;
    }
    this.#copperKey = copperKey;
    this.#copperFrameIndex = opts.cursor;
    ctx.drawImage(this.canvases.image("copper"), 0, 0);
    drawRecent(ctx, frame.shapes, recentShapeAges(opts.run, opts.cursor), t, opts.hiddenLayers, RECENT_WINDOW, theme.newCopper ?? NEW_COPPER_COLOR);
    drawAirline(ctx, frame, t);
    return { transform: t, shapes: opts.run.statics.length + frame.shapes.length, staticsRedrawn, copperRedrawn, copperExtended };
  }
}

/** Draws the whole scene for the frame at `cursor` in one pass. Returns the transform used (null when nothing drawn). */
export function drawScene(ctx: Canvas2D, opts: DrawOptions): Transform | null {
  const theme = opts.theme ?? DARK_THEME;
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, opts.width, opts.height);
  const bounds = computeBounds(opts.run);
  if (!bounds) return null;
  const frame = opts.cursor >= 0 ? opts.run.frames[opts.cursor] : undefined;
  const focus = opts.focus ?? frame !== undefined;
  const view = opts.view === "activity" && frame ? activityBounds(opts.run, opts.cursor, bounds) : bounds;
  const t = computeTransform(view, opts.width, opts.height);
  drawStatics(ctx, opts.run, t, opts.hiddenLayers, view, opts.width, opts.height, theme, focus);
  if (!frame) return t;
  drawCopper(ctx, frame.shapes, t, opts.hiddenLayers);
  drawRecent(ctx, frame.shapes, recentShapeAges(opts.run, opts.cursor), t, opts.hiddenLayers, RECENT_WINDOW, theme.newCopper ?? NEW_COPPER_COLOR);
  drawAirline(ctx, frame, t);
  return t;
}
