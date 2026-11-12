/**
 * Durable board workflow jobs. A long call outlives one MCP request (a client times a call out at ~30 min):
 * `runDurable` waits up to DURABLE_WAIT, then returns a job id while the job keeps running under its own
 * cancel signal. The `board_job` tool waits for it, reports it or cancels it. Any tool can wrap its handler.
 *
 * Jobs belong to the project they were started in (`board_job` only shows a caller its own project's jobs), live in the
 * daemon's memory (a restart forgets them; `unknownJobReason` says so), and finished ones are pruned after
 * FINISHED_TTL_MS or beyond the newest MAX_FINISHED.
 */
import type { ToolContext, ToolOutput } from "./registry";
import { ToolError } from "./registry";

export type DurableState = "running" | "done" | "failed" | "cancelled";

export type DurableJob = {
  id: string;
  tool: string;
  /** The project the job was started in (null: none was resolved). */
  projectId: string | null;
  startedAt: number;
  endedAt?: number;
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
/** The wait for this call: the session's choice for its client (a short tool timeout), else the default. */
export const durableWaitMs = (ctx?: Pick<ToolContext, "session">) => ctx?.session?.durableWaitMs?.() ?? waitMs;
/** Finished jobs are kept this long, and at most this many, for `board_job` to report. */
export const FINISHED_TTL_MS = 60 * 60_000;
export const MAX_FINISHED = 50;
const DAEMON_STARTED = Date.now();

/** Drop finished jobs older than FINISHED_TTL_MS, then all but the newest MAX_FINISHED finished ones. */
export function pruneDurableJobs(now = Date.now()): void {
  const finished = [...jobs.values()].filter((j) => j.state !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  finished.forEach((j, i) => {
    if (i >= MAX_FINISHED || now - (j.endedAt ?? now) > FINISHED_TTL_MS) jobs.delete(j.id);
  });
}

export const getDurableJob = (id: string) => (pruneDurableJobs(), jobs.get(id));
/** Jobs of one project (null: started without one), or every job when `projectId` is undefined. */
export const listDurableJobs = (projectId?: string | null) => {
  pruneDurableJobs();
  return [...jobs.values()].filter((j) => projectId === undefined || j.projectId === projectId);
};

/** Why `id` is not (or no longer) a job: started before the daemon restarted, or finished long enough ago to be pruned. */
export function unknownJobReason(id: string): string {
  const t = parseInt(/^bj-([0-9a-z]+)-/.exec(id)?.[1] ?? "", 36);
  if (Number.isFinite(t) && t < DAEMON_STARTED)
    return `board job ${id} was started before the daemon restarted; board jobs live in the daemon's memory, so its state and result are gone. Run the tool again (its records under .fabdesk/board/ are kept).`;
  return `no board job ${id}: unknown, or finished more than ${FINISHED_TTL_MS / 60_000} min ago and pruned (the newest ${MAX_FINISHED} finished jobs are kept that long). board_job {"action": "list"} lists this project's jobs.`;
}

/**
 * Cancel a job and report its real end state: `done`/`failed`/`cancelled` once it stopped within `ms`, `stopping` when it
 * has not yet, and the unchanged state when it had already finished.
 */
export async function cancelDurableJob(job: DurableJob, ms = 15_000): Promise<{ state: DurableState | "stopping"; already: boolean }> {
  if (job.state !== "running") return { state: job.state, already: true };
  job.controller.abort();
  await waitJob(job, ms);
  return { state: job.state === "running" ? "stopping" : job.state, already: false };
}

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
    projectId: ctx.project?.id ?? null,
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
      job.endedAt = Date.now();
    },
    (e) => {
      job.error = e;
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      job.endedAt = Date.now();
    },
  );
  pruneDurableJobs();
  jobs.set(job.id, job);
  return (await waitJob(job, opts.waitMs ?? durableWaitMs(ctx), ctx.signal)) ? settled(job) : stillRunning(job);
}

/** Wrap a tool handler so it runs as a durable job. */
export function durable<A>(tool: string, handler: (args: A, ctx: ToolContext) => Promise<ToolOutput>) {
  return (args: A, ctx: ToolContext): Promise<ToolOutput> => runDurable(ctx, tool, (c) => handler(args, c));
}
