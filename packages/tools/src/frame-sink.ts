/** Persists a route run's protocol messages to `frames.jsonl` and fans them out on the bus. */
import { appendFile } from "node:fs/promises";
import type { RouterWorkerMessage } from "@fabdesk/protocol";
import type { EventBusLike } from "./services";

/** A replay is diagnostic data; it must never be able to exhaust the user's disk. */
export const DEFAULT_ROUTE_FRAME_MAX_BYTES = 64 * 1024 * 1024;

export interface FrameSinkStats {
  /** Frames received from the router (after its own throttle). */
  frames: number;
  /** Frames with `event.kind === "connection"`. */
  connections: number;
  bytes: number;
  droppedBytes: number;
  truncated: boolean;
  maxShapes: number;
}

export class FrameSink {
  readonly stats: FrameSinkStats = {
    frames: 0,
    connections: 0,
    bytes: 0,
    droppedBytes: 0,
    truncated: false,
    maxShapes: 0,
  };
  #buffer: string[] = [];
  #flushing: Promise<void> | null = null;
  #pending: Promise<void> = Promise.resolve();
  #persistenceCapped = false;

  constructor(
    private readonly framesPath: string | null,
    private readonly bus: EventBusLike | null,
    private readonly onProgress?: (m: RouterWorkerMessage) => void,
    private readonly maxBytes = DEFAULT_ROUTE_FRAME_MAX_BYTES,
  ) {}

  onMessage = (m: RouterWorkerMessage): void => {
    const ts = Date.now();
    switch (m.kind) {
      case "meta":
        this.#record(m);
        this.bus?.emit({ ts, topic: "route.meta", meta: m });
        break;
      case "static":
        this.#record(m);
        this.stats.maxShapes = Math.max(this.stats.maxShapes, m.shapes.length);
        this.bus?.emit({ ts, topic: "route.static", static: m });
        break;
      case "frame":
        this.stats.frames += 1;
        if (m.event.kind === "connection") this.stats.connections += 1;
        this.stats.maxShapes = Math.max(this.stats.maxShapes, m.shapes.length);
        this.#record(m);
        this.bus?.emit({ ts, topic: "route.frame", frame: m });
        break;
      default:
        break;
    }
    this.onProgress?.(m);
    this.#scheduleFlush();
  };

  #record(m: RouterWorkerMessage): void {
    if (!this.framesPath) return;
    const line = JSON.stringify(m) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.#persistenceCapped || this.stats.bytes + bytes > this.maxBytes) {
      this.#persistenceCapped = true;
      this.stats.truncated = true;
      this.stats.droppedBytes += bytes;
      return;
    }
    this.stats.bytes += bytes;
    this.#buffer.push(line);
  }

  #scheduleFlush(): void {
    if (this.#flushing || !this.framesPath) return;
    this.#flushing = new Promise<void>((r) => setTimeout(r, 50)).then(async () => {
      this.#flushing = null;
      await this.flush();
    });
  }

  flush(): Promise<void> {
    if (this.#buffer.length === 0 || !this.framesPath) return this.#pending;
    const chunk = this.#buffer.join("");
    this.#buffer = [];
    const path = this.framesPath;
    this.#pending = this.#pending.then(() => appendFile(path, chunk));
    return this.#pending;
  }

  /** Waits for the timer flush and every pending write. */
  async close(): Promise<void> {
    await this.#flushing;
    await this.flush();
    await this.#pending;
  }
}
