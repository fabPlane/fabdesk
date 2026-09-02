/**
 * Job runner: per-class concurrency, AbortController per job, progress → `job.progress` events,
 * results persisted through an optional store.
 */
import type { CoreEvent, Job, JobStatus } from "@fabdesk/protocol";
import type { JobClass, JobsLike } from "@fabdesk/tools";
import { newId } from "./db";

export const DEFAULT_CONCURRENCY: Record<JobClass, number> = { router: 1, build: 1, kicad: 2, render: 1, default: 4 };

export type JobRecord = Job & { jobClass: JobClass; createdAt: string };

export interface JobStore {
  insert(j: { id: string; kind: string; projectId: string | null }): void;
  update(id: string, patch: { status?: JobStatus; progress?: number | null; note?: string | null; result?: unknown; error?: string | null; startedAt?: string; endedAt?: string }): void;
}

type Internal = {
  rec: JobRecord;
  jobClass: JobClass;
  run: (job: { signal: AbortSignal; progress(p: number, note?: string): void }) => Promise<unknown>;
  controller: AbortController;
  done: Promise<JobRecord>;
  resolve: (r: JobRecord) => void;
};

export class JobRunner implements JobsLike {
  private readonly jobs = new Map<string, Internal>();
  private readonly queues = new Map<JobClass, Internal[]>();
  private readonly running = new Map<JobClass, number>();
  private readonly concurrency: Record<JobClass, number>;

  constructor(
    private readonly opts: {
      emit: (e: CoreEvent) => void;
      store?: JobStore;
      concurrency?: Partial<Record<JobClass, number>>;
      keep?: number;
      /** Called for jobs that reject without being cancelled (error reporting hook). */
      onFailure?: (job: JobRecord, error: unknown) => void;
    } = { emit: () => {} },
  ) {
    this.concurrency = { ...DEFAULT_CONCURRENCY, ...(opts.concurrency ?? {}) };
  }

  enqueue(opts: { kind: string; jobClass: JobClass; projectId: string | null; run: Internal["run"] }): { id: string } {
    const id = newId("job");
    const rec: JobRecord = { id, kind: opts.kind, projectId: opts.projectId, status: "queued", progress: null, note: null, result: null, error: null, startedAt: null, endedAt: null, jobClass: opts.jobClass, createdAt: new Date().toISOString() };
    let resolve!: (r: JobRecord) => void;
    const done = new Promise<JobRecord>((r) => (resolve = r));
    const internal: Internal = { rec, jobClass: opts.jobClass, run: opts.run, controller: new AbortController(), done, resolve };
    this.jobs.set(id, internal);
    this.opts.store?.insert({ id, kind: opts.kind, projectId: opts.projectId });
    const q = this.queues.get(opts.jobClass) ?? [];
    q.push(internal);
    this.queues.set(opts.jobClass, q);
    queueMicrotask(() => this.pump(opts.jobClass));
    this.trim();
    return { id };
  }

  get(id: string): JobRecord | null {
    return this.jobs.get(id)?.rec ?? null;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((j) => j.rec);
  }

  wait(id: string): Promise<JobRecord> {
    const j = this.jobs.get(id);
    if (!j) return Promise.reject(new Error(`unknown job ${id}`));
    return j.done;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.rec.status === "queued") {
      const q = this.queues.get(j.jobClass);
      if (q) this.queues.set(j.jobClass, q.filter((x) => x !== j));
      this.finish(j, "cancelled", { error: "cancelled" });
      return true;
    }
    if (j.rec.status === "running") {
      j.controller.abort(new Error("cancelled"));
      return true;
    }
    return false;
  }

  cancelAll(): void {
    for (const j of this.jobs.values()) if (j.rec.status === "queued" || j.rec.status === "running") this.cancel(j.rec.id);
  }

  runningCount(jobClass?: JobClass): number {
    if (jobClass) return this.running.get(jobClass) ?? 0;
    let n = 0;
    for (const v of this.running.values()) n += v;
    return n;
  }

  private pump(jobClass: JobClass): void {
    const q = this.queues.get(jobClass) ?? [];
    while ((this.running.get(jobClass) ?? 0) < this.concurrency[jobClass] && q.length > 0) {
      const j = q.shift()!;
      this.start(j);
    }
  }

  private start(j: Internal): void {
    this.running.set(j.jobClass, (this.running.get(j.jobClass) ?? 0) + 1);
    j.rec.status = "running";
    j.rec.startedAt = new Date().toISOString();
    this.opts.store?.update(j.rec.id, { status: "running", startedAt: j.rec.startedAt });
    this.opts.emit({ ts: Date.now(), topic: "job.started", jobId: j.rec.id, kind: j.rec.kind, ...(j.rec.projectId ? { projectId: j.rec.projectId } : {}) });
    const progress = (p: number, note?: string) => {
      if (j.rec.status !== "running") return;
      j.rec.progress = Math.max(0, Math.min(1, p));
      j.rec.note = note ?? j.rec.note;
      this.opts.emit({ ts: Date.now(), topic: "job.progress", jobId: j.rec.id, progress: j.rec.progress, ...(note ? { note } : {}) });
    };
    j.run({ signal: j.controller.signal, progress })
      .then(
        (result) => {
          if (j.controller.signal.aborted) this.finish(j, "cancelled", { error: "cancelled" });
          else this.finish(j, "done", { result });
        },
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (j.controller.signal.aborted) this.finish(j, "cancelled", { error: msg });
          else {
            this.finish(j, "failed", { error: msg });
            try {
              this.opts.onFailure?.(j.rec, e);
            } catch {
              /* reporting must never affect the job */
            }
          }
        },
      )
      .finally(() => {
        this.running.set(j.jobClass, Math.max(0, (this.running.get(j.jobClass) ?? 1) - 1));
        this.pump(j.jobClass);
      });
  }

  private finish(j: Internal, status: "done" | "failed" | "cancelled", data: { result?: unknown; error?: string }): void {
    if (j.rec.status === "done" || j.rec.status === "failed" || j.rec.status === "cancelled") return;
    j.rec.status = status;
    j.rec.endedAt = new Date().toISOString();
    if (status === "done") {
      j.rec.result = data.result ?? null;
      j.rec.progress = 1;
    } else j.rec.error = data.error ?? null;
    this.opts.store?.update(j.rec.id, { status, endedAt: j.rec.endedAt, ...(status === "done" ? { result: j.rec.result, progress: 1 } : { error: j.rec.error }) });
    if (status === "done") this.opts.emit({ ts: Date.now(), topic: "job.done", jobId: j.rec.id, result: j.rec.result });
    else if (status === "failed") this.opts.emit({ ts: Date.now(), topic: "job.failed", jobId: j.rec.id, error: j.rec.error ?? "failed" });
    else this.opts.emit({ ts: Date.now(), topic: "job.cancelled", jobId: j.rec.id });
    j.resolve(j.rec);
  }

  /** Keep memory bounded: drop the oldest finished jobs beyond `keep` (DB keeps history). */
  private trim(): void {
    const keep = this.opts.keep ?? 500;
    if (this.jobs.size <= keep) return;
    const finished = [...this.jobs.values()].filter((j) => j.rec.status === "done" || j.rec.status === "failed" || j.rec.status === "cancelled");
    for (const j of finished.slice(0, this.jobs.size - keep)) this.jobs.delete(j.rec.id);
  }
}
