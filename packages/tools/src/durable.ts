/**
 * Durable board workflow jobs. A long call outlives one MCP request (a client times a call out at ~30 min):
 * `runDurable` waits up to DURABLE_WAIT, then returns a job id while the job keeps running under its own
 * cancel signal. The `board_job` tool waits for it, reports it or cancels it. Any tool can wrap its handler.
 */
import type { ToolContext, ToolOutput } from "./registry";
import { ToolError } from "./registry";

export type DurableState = "running" | "done" | "failed" | "cancelled";

export type DurableJob = {
  id: string;
  tool: string;
  startedAt: number;
  state: DurableState;
  notes: string[];
  result?: ToolOutput;
  error?: unknown;
  controller: AbortController;
  done: Promise<void>;
};

const jobs = new Map<string, DurableJob>();
let waitMs = 25 * 60_000;
/** Tests shorten the wait. */
export function setDurableWaitMs(ms: number) {
  waitMs = ms;
}
export const durableWaitMs = () => waitMs;
export const getDurableJob = (id: string) => jobs.get(id);
export const listDurableJobs = () => [...jobs.values()];

const out = (text: string, json: unknown): ToolOutput => ({ text, json });

/** Resolve true when the job finished, false on timeout or when the waiting call itself is aborted. */
export async function waitJob(job: DurableJob, ms: number, signal?: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((z) => (timer = setTimeout(() => z(false), ms)));
  const aborted = new Promise<boolean>((z) => signal?.addEventListener("abort", () => z(false), { once: true }));
  const r = await Promise.race([job.done.then(() => true), timeout, aborted]);
  clearTimeout(timer);
  return r;
}

/** The finished job's result, or its error rethrown. */
export function settled(job: DurableJob): ToolOutput {
  if (job.state === "done") return job.result!;
  throw job.error instanceof Error ? job.error : new ToolError(String(job.error ?? job.state), job.state === "cancelled" ? "cancelled" : "internal");
}

export function stillRunning(job: DurableJob): ToolOutput {
  const s = Math.round((Date.now() - job.startedAt) / 1000);
  return out(
    `still running: board job ${job.id} (${job.tool}), ${s} s so far; it continues on its own.\n` +
      `board_job {"jobId": "${job.id}"} waits for its result (or action "status" / "cancel").\n` +
      job.notes.slice(-8).join("\n"),
    { jobId: job.id, state: job.state, runningSeconds: s, lastNotes: job.notes.slice(-8) },
  );
}

/**
 * Run `fn` as a durable job. `fn` gets a context whose `signal` is the job's own (not the request's) and whose
 * `progress` also keeps the last notes for `board_job status`. Returns the result if it finishes within
 * `opts.waitMs` (default 25 min), else the job id.
 */
export async function runDurable(
  ctx: ToolContext,
  tool: string,
  fn: (ctx: ToolContext) => Promise<ToolOutput>,
  opts: { waitMs?: number } = {},
): Promise<ToolOutput> {
  const controller = new AbortController();
  const job = {
    id: `bj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    tool,
    startedAt: Date.now(),
    state: "running",
    notes: [],
    controller,
  } as unknown as DurableJob;
  const jctx = Object.create(ctx) as ToolContext;
  Object.defineProperty(jctx, "signal", { value: controller.signal });
  Object.defineProperty(jctx, "progress", {
    value: (p: number, note?: string) => {
      if (note) {
        job.notes.push(note);
        if (job.notes.length > 300) job.notes.splice(0, 100);
      }
      try {
        ctx.progress(p, note);
      } catch {
        /* the request that started the job may be gone */
      }
    },
  });
  job.done = fn(jctx).then(
    (r) => {
      job.result = r;
      job.state = "done";
    },
    (e) => {
      job.error = e;
      job.state = controller.signal.aborted ? "cancelled" : "failed";
    },
  );
  jobs.set(job.id, job);
  return (await waitJob(job, opts.waitMs ?? waitMs, ctx.signal)) ? settled(job) : stillRunning(job);
}

/** Wrap a tool handler so it runs as a durable job. */
export function durable<A>(tool: string, handler: (args: A, ctx: ToolContext) => Promise<ToolOutput>) {
  return (args: A, ctx: ToolContext): Promise<ToolOutput> => runDurable(ctx, tool, (c) => handler(args, c));
}
