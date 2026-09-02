import type {
  CinemaShape,
  RouteMeta,
  RouteProgressEvent,
  RouteResult,
  RouterWorkerMessage,
  SimplifiedPcbTrace,
} from "@fabdesk/protocol";

export interface FrameEmitterOptions {
  runId: string;
  router: string;
  /** Minimum gap between `attempt` frames; structural events always land. */
  minFrameIntervalMs: number;
  post: (message: RouterWorkerMessage) => void;
}

/**
 * Sequences and throttles one run's protocol messages. Both adapters go through this so the
 * worker and the in-process path produce the same stream: `meta`, `static`, `frame`*, `result`.
 */
export class FrameEmitter {
  readonly #runId: string;
  readonly #router: string;
  readonly #gate: number;
  readonly #post: (message: RouterWorkerMessage) => void;
  readonly #started = performance.now();
  #seq = 0;
  #lastAttempt = -Infinity;

  constructor(options: FrameEmitterOptions) {
    this.#runId = options.runId;
    this.#router = options.router;
    this.#gate = options.minFrameIntervalMs;
    this.#post = options.post;
  }

  /** Frames posted so far (throttled `attempt`s excluded). */
  get framesSent(): number {
    return this.#seq;
  }

  get elapsedMs(): number {
    return performance.now() - this.#started;
  }

  meta(meta: Omit<RouteMeta, "kind" | "runId" | "router">): void {
    this.#post({ kind: "meta", runId: this.#runId, router: this.#router, ...meta });
  }

  static(shapes: CinemaShape[]): void {
    this.#post({ kind: "static", runId: this.#runId, shapes });
  }

  /**
   * Posts a frame; `shapes` may be lazy so a throttled `attempt` costs nothing.
   * Returns false when the throttle dropped it.
   */
  frame(event: RouteProgressEvent, shapes: CinemaShape[] | (() => CinemaShape[])): boolean {
    const now = performance.now();
    if (event.kind === "attempt" && now - this.#lastAttempt < this.#gate) {
      return false;
    }
    if (event.kind === "attempt") {
      this.#lastAttempt = now;
    }
    this.#seq += 1;
    this.#post({
      kind: "frame",
      runId: this.#runId,
      seq: this.#seq,
      event,
      elapsedMs: now - this.#started,
      shapes: typeof shapes === "function" ? shapes() : shapes,
    });
    return true;
  }

  result(result: RouteResult): void {
    this.#post({ kind: "result", runId: this.#runId, result });
  }
}

export interface TraceShapeContext {
  /** Layer name → cinema layer index (unknown names map to 0). */
  layerIndex: (layer: string) => number;
  /** Connection name → cinema net number (unknown names map to -1). */
  netOf: (connectionName: string | undefined) => number;
  /** Via bounding-box size in frame units. */
  viaDiameter: number;
  /** Multiply trace coordinates by this to get frame units. */
  unitsPerMm?: number;
}

/**
 * Turns simplified traces into cinema shapes: one `trace` per same-layer run of wire points and a
 * `via` box per layer change. Ids are positional (stable within a frame, not across frames).
 */
export function tracesToShapes(
  traces: readonly SimplifiedPcbTrace[],
  ctx: TraceShapeContext,
): CinemaShape[] {
  const scale = ctx.unitsPerMm ?? 1;
  const shapes: CinemaShape[] = [];
  let nextId = 1;
  for (const trace of traces) {
    const net = ctx.netOf(trace.connection_name);
    let pts: number[] = [];
    let layer = -1;
    let width = 0;
    const flush = (): void => {
      if (pts.length >= 4) {
        shapes.push({ k: "trace", id: nextId++, layer, net, pts, w: width * scale });
      }
      pts = [];
    };
    for (const point of trace.route) {
      if (point.route_type === "via") {
        flush();
        const r = ctx.viaDiameter / 2;
        const x = point.x * scale;
        const y = point.y * scale;
        shapes.push({ k: "via", id: nextId++, layer: -1, net, pts: [x - r, y - r, x + r, y + r] });
        continue;
      }
      const pointLayer = ctx.layerIndex(point.layer);
      if (pointLayer !== layer) {
        flush();
        layer = pointLayer;
        width = point.width;
      }
      pts.push(point.x * scale, point.y * scale);
    }
    flush();
  }
  return shapes;
}
