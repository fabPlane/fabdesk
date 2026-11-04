import type { PlacementJob, PlacementResult } from "./placement.worker";
/** A fresh worker bounds each operation and permits immediate cancellation on project change. */
export function placementJob(job: PlacementJob, signal: AbortSignal): Promise<PlacementResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Canceled", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./placement.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Canceled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("This operation took too long. Try a smaller selection or board."));
    }, 30_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<PlacementResult>) => {
      cleanup();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("The placement worker could not finish. Your draft is unchanged."));
    };
    worker.postMessage(job);
  });
}
