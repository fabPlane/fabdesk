/**
 * HTTP client for a FabPlane PCB bridge (`@fp-pcb/bridge`): sessions (one `kicad-cli api-server`
 * per project) and its jobs — compile and route. Same shape as `AppBridgeClient`: every failure to
 * reach the bridge is a `ToolError("unavailable")` with the reason, so tools can say what is missing.
 *
 * Jobs are followed over SSE (`GET …/<kind>/:job`, `Accept: text/event-stream`): the bridge
 * streams `state`, `progress`, then `done` or `error`, each carrying the job record. If the stream
 * ends without a terminal event the record is fetched once more as JSON. Aborting the signal
 * sends `DELETE` and rejects with `cancelled`; the bridge honours it between stages.
 */
import { z } from "zod/v4";
import {
  FP_PCB_ROUTE_TERMINAL_STATES,
  FP_PCB_SSE_EVENTS,
  FP_PCB_TERMINAL_STATES,
  FpPcbCompileJob,
  FpPcbHealth,
  FpPcbRouteJob,
  FpPcbSession,
  type FpPcbCompileRequest,
  type FpPcbRouteRequest,
} from "@fabdesk/protocol";
import { ToolError } from "@fabdesk/tools";

export type FpPcbBridgeClientOptions = {
  /** Origin, e.g. `http://127.0.0.1:4020`. */
  url: string;
  fetch?: typeof fetch;
  /** Per-request timeout for the JSON calls; a job follow is bounded by its own cap. */
  timeoutMs?: number;
};

export type JobFollow<J> = {
  signal?: AbortSignal;
  onProgress?: (job: J) => void;
  /** Upper bound on one job, default 10 minutes. */
  maxMs?: number;
};

export type SseEvent = { event: string; data: string };

/**
 * Splits a `text/event-stream` body into events. Handles multi-line `data:`, ignores comment
 * lines (`: keepalive`), and tolerates a final event with no trailing blank line.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (block: string): SseEvent | null => {
    let event = "message";
    const data: string[] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
        const ev = flush(block);
        if (ev) yield ev;
      }
    }
    const tail = flush(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

type JobKind = "compile" | "route";

export class FpPcbBridgeClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FpPcbBridgeClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async health(): Promise<FpPcbHealth> {
    return FpPcbHealth.parse(await this.json("GET", "/health"));
  }

  async sessions(): Promise<FpPcbSession[]> {
    const res = (await this.json("GET", "/sessions")) as { sessions?: unknown[] };
    return (res.sessions ?? []).map((s) => FpPcbSession.parse(s));
  }

  /** `path` is a project or board file on the bridge's filesystem; null starts a bare server. */
  async createSession(path: string | null): Promise<FpPcbSession> {
    const res = (await this.json("POST", "/sessions", { path })) as { session: unknown };
    return FpPcbSession.parse(res.session);
  }

  async deleteSession(id: string): Promise<void> {
    await this.json("DELETE", `/sessions/${encodeURIComponent(id)}`);
  }

  /** A running session on `path` if the bridge has one, else a new one. */
  async sessionFor(path: string | null): Promise<FpPcbSession> {
    const existing = (await this.sessions()).find((s) => s.path === path && s.state !== "failed" && s.state !== "stopped" && s.state !== "exited");
    return existing ?? this.createSession(path);
  }

  /** Starts a compile on `sessionId` and follows it to a terminal state. A 404 (`not_found`) means the session is gone. */
  compile(sessionId: string, request: FpPcbCompileRequest, follow: JobFollow<FpPcbCompileJob> = {}): Promise<FpPcbCompileJob> {
    return this.job("compile", sessionId, request, follow, FpPcbCompileJob, (j) => FP_PCB_TERMINAL_STATES.has(j.state));
  }

  /** Starts a route job on `sessionId` and follows it to a terminal state. */
  route(sessionId: string, request: FpPcbRouteRequest, follow: JobFollow<FpPcbRouteJob> = {}): Promise<FpPcbRouteJob> {
    return this.job("route", sessionId, request, follow, FpPcbRouteJob, (j) => FP_PCB_ROUTE_TERMINAL_STATES.has(j.state));
  }

  /** Cancels every running job of a kind on a session. */
  async cancelJobs(kind: JobKind, sessionId: string): Promise<number> {
    const base = `/sessions/${encodeURIComponent(sessionId)}/${kind}`;
    const res = (await this.json("GET", base)) as { jobs?: Array<{ id: string; state: string }> };
    const running = (res.jobs ?? []).filter((j) => !["done", "failed", "cancelled"].includes(j.state));
    for (const j of running) await this.json("DELETE", `${base}/${encodeURIComponent(j.id)}`).catch(() => undefined);
    return running.length;
  }

  private async job<J extends { id: string; state: string }>(
    kind: JobKind,
    sessionId: string,
    request: unknown,
    follow: JobFollow<J>,
    schema: z.ZodType<J>,
    terminal: (j: J) => boolean,
  ): Promise<J> {
    follow.signal?.throwIfAborted();
    const base = `/sessions/${encodeURIComponent(sessionId)}/${kind}`;
    const started = (await this.json("POST", base, request)) as { job: unknown };
    let job = schema.parse(started.job);
    if (terminal(job)) return job;

    const jobPath = `${base}/${encodeURIComponent(job.id)}`;
    const maxMs = follow.maxMs ?? 10 * 60_000;
    const deadline = AbortSignal.timeout(maxMs);
    const signal = follow.signal ? AbortSignal.any([follow.signal, deadline]) : deadline;
    const cancel = async () => {
      await this.json("DELETE", jobPath).catch(() => undefined);
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${jobPath}`, { headers: { accept: "text/event-stream" }, signal });
    } catch (e) {
      if (follow.signal?.aborted) {
        await cancel();
        throw new ToolError(`${kind} cancelled`, "cancelled");
      }
      throw this.unreachable(e);
    }
    if (!res.ok || !res.body) throw await this.failure(res, jobPath);

    try {
      for await (const ev of parseSse(res.body)) {
        let parsed: J;
        try {
          const data = JSON.parse(ev.data) as Record<string, unknown>;
          // `state` / `done` / `error` carry the whole job; a route `progress` event carries only
          // `{ state, progress, log }`, so it is laid over the last full record.
          parsed = schema.parse(ev.event === FP_PCB_SSE_EVENTS.progress && !("id" in data) ? { ...job, ...data } : data);
        } catch {
          continue;
        }
        job = parsed;
        if (ev.event === FP_PCB_SSE_EVENTS.done || ev.event === FP_PCB_SSE_EVENTS.error || terminal(job)) return job;
        follow.onProgress?.(job);
      }
    } catch (e) {
      if (follow.signal?.aborted) {
        await cancel();
        throw new ToolError(`${kind} cancelled`, "cancelled");
      }
      if (deadline.aborted) {
        await cancel();
        throw new ToolError(`${kind} exceeded ${Math.round(maxMs / 1000)} s`, "unavailable");
      }
      throw this.unreachable(e);
    }
    // Stream ended without a terminal event: the record is authoritative.
    job = schema.parse(((await this.json("GET", jobPath)) as { job: unknown }).job);
    if (terminal(job)) return job;
    throw new ToolError(`${kind} job ${job.id} ended its stream in state ${job.state}`, "unavailable");
  }

  private async json(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw this.unreachable(e);
    }
    if (!res.ok) throw await this.failure(res, path);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private unreachable(e: unknown): ToolError {
    return new ToolError(`FabPlane PCB bridge unreachable at ${this.url}: ${e instanceof Error ? e.message : String(e)}`, "unavailable");
  }

  private async failure(res: Response, path: string): Promise<ToolError> {
    let detail = "";
    try {
      const json = (await res.json()) as { error?: unknown };
      if (typeof json.error === "string") detail = json.error;
    } catch {
      /* no body */
    }
    const message = `FabPlane PCB bridge ${res.status} on ${path}${detail ? `: ${detail}` : ""}`;
    return new ToolError(message, res.status === 404 ? "not_found" : res.status === 400 ? "invalid_args" : "unavailable");
  }
}
