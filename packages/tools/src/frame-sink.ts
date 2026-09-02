/** Persists a route run's protocol messages to `frames.jsonl` and fans them out on the bus. */
import { appendFile } from "node:fs/promises";
import type { RouterWorkerMessage } from "@fabdesk/protocol";
import type { EventBusLike } from "./services";

export interface FrameSinkStats {
  /** Frames received from the router (after its own throttle). */
  frames: number;
  /** Frames with `event.kind === "connection"`. */
  connections: number;
  bytes: number;
  maxShapes: number;
}

export class FrameSink {
  readonly stats: FrameSinkStats = { frames: 0, connections: 0, bytes: 0, maxShapes: 0 };
  #buffer: string[] = [];
  #flushing: Promise<void> | null = null;
  #pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly framesPath: string | null,
    private readonly bus: EventBusLike | null,
    private readonly onProgress?: (m: RouterWorkerMessage) => void,
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
    this.stats.bytes += line.length;
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
