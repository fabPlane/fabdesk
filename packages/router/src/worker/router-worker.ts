/**
 * The router worker: receives `{ kind: "route", request }`, loads the adapter through the shared
 * registry (so the channel gate applies here too), and posts protocol messages back. The adapter
 * posts `meta`, `static`, `frame`s and the `result`; a throw becomes exactly one `error`.
 */
import { RouteRequest, type RouterWorkerMessage } from "@fabdesk/protocol";

import { loadAdapter } from "../registry";

interface RouteCommand {
  kind: "route";
  request: unknown;
  /** The host's `isInternalChannel()` verdict; see `LoadAdapterOptions.internal`. */
  internal?: boolean;
}

const port = self as unknown as Worker;
const post = (message: RouterWorkerMessage): void => port.postMessage(message);

port.onmessage = async (event: MessageEvent) => {
  const command = event.data as Partial<RouteCommand> | undefined;
  if (command?.kind !== "route") {
    return;
  }
  const raw = command.request as { runId?: unknown } | undefined;
  const runId = typeof raw?.runId === "string" ? raw.runId : "";
  const parsed = RouteRequest.safeParse(command.request);
  if (!parsed.success) {
    post({ kind: "error", runId, message: `invalid RouteRequest: ${parsed.error.message}` });
    return;
  }
  const request = parsed.data;
  try {
    const adapter = await loadAdapter(request.router, {
      ...(typeof command.internal === "boolean" ? { internal: command.internal } : {}),
    });
    if (adapter === undefined) {
      throw new Error(`router "${request.router}" is not available in this build`);
    }
    await adapter.route(request, { onMessage: post });
  } catch (error) {
    post({
      kind: "error",
      runId: request.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
