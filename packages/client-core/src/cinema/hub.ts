/**
 * Fan-out for live `route.*` events on clients without a cinema store.
 *
 * The event reducer hands route frames to whatever `RouteSink` the `CoreProvider` was given. The
 * desktop passes its zustand cinema store; the phone has no global store for runs — the cinema
 * screen owns the run it is showing — so it passes this hub and the screen subscribes to it while
 * it is mounted. Frames that arrive with nobody listening are dropped on purpose: the screen
 * catches up from `/route/runs/:id/frames?from=` when it opens.
 */
import type { RouteFrameLine, RouteResult } from "@fabdesk/protocol";
import type { RouteSink } from "../events";

export type RouteFrameListener = (line: RouteFrameLine) => void;
export type RouteDoneListener = (result: RouteResult) => void;

export class RouteFrameHub implements RouteSink {
  #frames = new Set<RouteFrameListener>();
  #done = new Set<RouteDoneListener>();

  ingest(line: RouteFrameLine): void {
    for (const fn of this.#frames) fn(line);
  }

  setDone(result: RouteResult): void {
    for (const fn of this.#done) fn(result);
  }

  /** Returns the unsubscribe. */
  subscribe(onLine: RouteFrameListener, onDone?: RouteDoneListener): () => void {
    this.#frames.add(onLine);
    if (onDone) this.#done.add(onDone);
    return () => {
      this.#frames.delete(onLine);
      if (onDone) this.#done.delete(onDone);
    };
  }

  get listeners(): number {
    return this.#frames.size;
  }
}

/** The instance to pass as `route` to `CoreProvider` on clients that use the hub. */
export const routeFrameHub = new RouteFrameHub();
