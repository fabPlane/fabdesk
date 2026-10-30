import { BoardSourceSelection, type Job } from "@fabdesk/protocol";
import type { LiveJob } from "./stores/runs";

export type ProjectJob = Job & { board?: BoardSourceSelection };
export const jobIsActive = (job: Pick<Job, "status">) => job.status === "queued" || job.status === "running";

/** Server history survives navigation/restarts; live events fill in pending progress, never ownership. */
export function projectJobs(projectId: string, saved: Job[], live: Record<string, LiveJob>, endpoint: string): ProjectJob[] {
  const rows = new Map<string, ProjectJob>();
  for (const job of saved) if (job.projectId === projectId) rows.set(job.id, { ...job });
  for (const job of Object.values(live)) {
    const previous = rows.get(job.jobId);
    if (job.endpoint ? job.endpoint !== endpoint : !previous) continue;
    if (job.projectId !== projectId && !(job.projectId === undefined && previous)) continue;
    // A final server record wins over an older live running event.
    const status = previous && !jobIsActive(previous) ? previous.status : job.status;
    const progress = status === "done" ? 1 : job.progress ?? previous?.progress ?? null;
    rows.set(job.jobId, {
      id: job.jobId, kind: job.kind, projectId, status,
      progress: typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null,
      note: jobIsActive({ status }) ? job.note ?? previous?.note ?? null : previous?.note ?? job.note ?? null,
      error: previous?.error ?? job.error ?? null,
      result: previous?.result ?? job.result ?? null,
      startedAt: previous?.startedAt ?? (Number.isFinite(job.startedAt) ? new Date(job.startedAt).toISOString() : null),
      endedAt: previous?.endedAt ?? null,
      ...(job.board ? { board: { ...job.board } } : {}),
    });
  }
  return [...rows.values()].sort((a, b) => Number(jobIsActive(b)) - Number(jobIsActive(a))
    || (b.endedAt ?? b.startedAt ?? "").localeCompare(a.endedAt ?? a.startedAt ?? "") || a.id.localeCompare(b.id));
}

/** Descriptive source metadata only. Navigation still checks the current declaration. */
export function projectJobBoard(job: ProjectJob): BoardSourceSelection | null {
  if (job.board) return BoardSourceSelection.safeParse(job.board).data ?? null;
  const result = job.result as { json?: { _board?: unknown }; _board?: unknown } | null;
  const raw = result?.json?._board ?? result?._board;
  if (!raw || typeof raw !== "object" || !("projectId" in raw) || raw.projectId !== job.projectId) return null;
  const record = raw as Record<string, unknown>;
  const parsed = BoardSourceSelection.safeParse({ sourceId: record.sourceId, manifestSha256: record.manifestSha256 });
  return parsed.success ? parsed.data : null;
}
