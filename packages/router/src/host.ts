import { RouteRequest, type RouteResult, type RouterWorkerMessage } from "@fabdesk/protocol";

import { isInternalChannel } from "./registry";
import { RouteAbortedError, type RouteHooks } from "./types";

export interface RouterHostOptions {
  /** Defaults to this package's `src/worker/router-worker.ts`. */
  workerUrl?: URL;
}

/**
 * Runs one route at a time in a Bun Worker so a blocking router never stalls the host, and
 * cancels by `terminate()` -- the only stop that works for a synchronous router. Each route gets
 * a fresh worker; it is torn down when the result, an error, or a cancel lands.
 */
export class RouterHost {
  readonly #workerUrl: URL;
  #active: { worker: Worker; settle: (error: Error) => void } | undefined;

  constructor(options: RouterHostOptions = {}) {
    this.#workerUrl = options.workerUrl ?? new URL("./worker/router-worker.ts", import.meta.url);
  }

  get busy(): boolean {
    return this.#active !== undefined;
  }

  route(request: RouteRequest, hooks: RouteHooks): Promise<RouteResult> {
    if (this.#active !== undefined) {
      return Promise.reject(new Error("RouterHost is busy: one route at a time per host"));
    }
    if (hooks.signal?.aborted) {
      return Promise.reject(new RouteAbortedError());
    }
    const parsed = RouteRequest.safeParse(request);
    if (!parsed.success) {
      return Promise.reject(new Error(`invalid RouteRequest: ${parsed.error.message}`));
    }
    const validated = parsed.data;

    return new Promise<RouteResult>((resolve, reject) => {
      const worker = new Worker(this.#workerUrl.href);
      const signal = hooks.signal;
      let settled = false;
      const finish = (outcome: { result: RouteResult } | { error: Error }): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        this.#active = undefined;
        if ("result" in outcome) {
          resolve(outcome.result);
        } else {
          reject(outcome.error);
        }
      };
      const onAbort = (): void => finish({ error: new RouteAbortedError() });

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as RouterWorkerMessage;
        try {
          hooks.onMessage(message);
        } catch (error) {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
          return;
        }
        if (message.kind === "result") {
          finish({ result: message.result });
        } else if (message.kind === "error") {
          finish({ error: new Error(message.message) });
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        finish({ error: new Error(event.message || "router worker crashed") });
      };
      this.#active = { worker, settle: (error) => finish({ error }) };
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ kind: "route", request: validated, internal: isInternalChannel() });
    });
  }

  /** Terminates the running worker; the pending `route()` rejects with `RouteAbortedError`. */
  cancel(): void {
    this.#active?.settle(new RouteAbortedError());
  }

  dispose(): void {
    this.cancel();
  }
}
