import { setTimeout as delay } from "node:timers/promises";

const transportErrors = new Set([
  "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED",
  "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EPIPE",
  "HTTP_ERROR_408", "HTTP_ERROR_502", "HTTP_ERROR_503", "HTTP_ERROR_504",
]);

function transient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && typeof error.code === "string") return transportErrors.has(error.code);
  // Electron net errors may expose only "net::ERR_TIMED_OUT". Its HTTP
  // executor also uses a plain Error for an unsuccessful binary download.
  const net = /^net::(ERR_[A-Z_]+)$/.exec(error.message);
  return (net?.[1] !== undefined && transportErrors.has(net[1]))
    || error.message === "Request timed out"
    || /^Cannot download "[^"\r\n]+", status (408|502|503|504):/.test(error.message);
}

/** Reuse the same checked release, checksum and cancellation token. Staging
 * and installation happen outside this function and are never replayed. */
export async function retryUpdateDownload<T>(
  download: () => Promise<T>,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) => delay(ms, undefined, { signal: abort }),
): Promise<T> {
  const backoff = [1_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await download(); }
    catch (error) {
      signal.throwIfAborted();
      const ms = backoff[attempt];
      if (ms === undefined || !transient(error)) throw error;
      await wait(ms, signal);
    }
  }
}
