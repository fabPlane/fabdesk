/**
 * The jobs sheet's rows: `GET /jobs` merged with what the event stream has said since.
 *
 * The runs store only learns about a job from `job.started` (or from this app starting one), and
 * the list route only answers on request, so neither alone is current: the store has the live
 * status and progress of jobs seen while connected, the list has everything else. Live wins for
 * anything it knows.
 */
import type { Job, JobStatus } from "@fabdesk/protocol";
import type { LiveJob } from "@fabdesk/client-core";

export interface JobRow {
  id: string;
  kind: string;
  projectId: string | null;
  status: JobStatus;
  progress: number | null;
  note: string | null;
  error: string | null;
  /** Epoch ms; null when the daemon has not started it. */
  startedAt: number | null;
  endedAt: number | null;
}

export const ACTIVE: ReadonlySet<JobStatus> = new Set(["queued", "running"]);

function fromListed(j: Job): JobRow {
  return {
    id: j.id,
    kind: j.kind,
    projectId: j.projectId,
    status: j.status,
    progress: j.progress,
    note: j.note,
    error: j.error,
    startedAt: j.startedAt ? Date.parse(j.startedAt) : null,
    endedAt: j.endedAt ? Date.parse(j.endedAt) : null,
  };
}

function fromLive(j: LiveJob): JobRow {
  return {
    id: j.jobId,
    kind: j.kind,
    projectId: j.projectId ?? null,
    status: j.status,
    progress: j.progress ?? null,
    note: j.note ?? null,
    error: j.error ?? null,
    startedAt: j.startedAt,
    endedAt: null,
  };
}

/** Active jobs first (newest on top), then finished ones newest first. */
export function mergeJobs(listed: Job[] | undefined, live: Record<string, LiveJob>): JobRow[] {
  const byId = new Map<string, JobRow>();
  for (const j of listed ?? []) byId.set(j.id, fromListed(j));
  for (const l of Object.values(live)) {
    const base = byId.get(l.jobId);
    const row = fromLive(l);
    byId.set(
      l.jobId,
      base
        ? {
            ...base,
            status: row.status,
            progress: row.progress ?? base.progress,
            note: row.note ?? base.note,
            error: row.error ?? base.error,
            // A finished job the list has not re-read yet: keep its end unknown rather than stale.
            endedAt: ACTIVE.has(row.status) ? null : base.endedAt,
          }
        : row,
    );
  }
  return [...byId.values()].sort((a, b) => {
    const aa = ACTIVE.has(a.status) ? 0 : 1;
    const bb = ACTIVE.has(b.status) ? 0 : 1;
    return aa - bb || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id);
  });
}

/** How long a job took, or has been going; null before it started. */
export function jobDurationMs(job: JobRow, now: number): number | null {
  if (job.startedAt === null) return null;
  return Math.max(0, (job.endedAt ?? now) - job.startedAt);
}

/** `render_board` → `render board`; tool names are snake_case. */
export function describeKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

export function jobsFor(rows: JobRow[], projectId: string): JobRow[] {
  return rows.filter((r) => r.projectId === projectId);
}

export function activeCount(rows: JobRow[]): number {
  return rows.filter((r) => ACTIVE.has(r.status)).length;
}
