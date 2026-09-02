import type { RouteRequest, RouteResult, RouterId, RouterWorkerMessage } from "@fabdesk/protocol";

/** What `availableRouters()` learns about one router without routing anything. */
export interface RouterProbe {
  id: RouterId;
  /** The adapter module could be loaded. */
  present: boolean;
  /** The adapter can route right now. */
  ready: boolean;
  version: string;
  detail: string;
}

export interface RouteHooks {
  /** Receives every protocol message: `meta`, `static`, throttled `frame`s, then the `result`. */
  onMessage(message: RouterWorkerMessage): void;
  /**
   * Cancels the run. In-process adapters honour it at their next yield point; a blocking adapter
   * (js_autorouter) cannot, which is why `RouterHost` cancels by terminating the worker instead.
   */
  signal?: AbortSignal | undefined;
}

export interface RouterAdapter {
  readonly id: RouterId;
  probe(): Promise<RouterProbe>;
  /**
   * Routes `request.srj`, posting `meta` → `static` → `frame`* → `result` through `hooks.onMessage`
   * and resolving with that same result. Throws (never posts `error`) on failure; the worker turns
   * a throw into exactly one `error` message.
   */
  route(request: RouteRequest, hooks: RouteHooks): Promise<RouteResult>;
}

export class RouteAbortedError extends Error {
  constructor(message = "routing aborted") {
    super(message);
    this.name = "RouteAbortedError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RouteAbortedError();
  }
}
