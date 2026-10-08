/** Presenting `GET /projects/:id/route-runs` rows in the Route runs list. */
import type { RouteRunSummary } from "@fabdesk/client-core";
import { formatDuration, relativeTime } from "./format";

export type RunTone = "default" | "success" | "danger" | "warning";

export interface RunRow {
  id: string;
  title: string;
  /** `capacity · 2m 05s · 3h ago` */
  subtitle: string;
  status: RouteRunSummary["status"];
  tone: RunTone;
  live: boolean;
}

const LIVE_STATUSES: ReadonlySet<RouteRunSummary["status"]> = new Set([
  "queued",
  "running",
  "cancel_requested",
  "cancelling",
]);

export function runTone(status: RouteRunSummary["status"]): RunTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "interrupted":
      return "danger";
    case "cancelled":
    case "timed_out":
      return "warning";
    default:
      return "default";
  }
}

/** `12/14 routed, 2 open` for a finished run, `routing…` while live, else the status. */
export function runTitle(run: RouteRunSummary): string {
  if (run.status === "queued") return "Queued…";
  if (run.status === "running") return "Routing…";
  if (run.status === "cancel_requested" || run.status === "cancelling") return "Cancelling…";
  if (run.result) {
    const { complete, open } = run.result;
    const total = complete.length + open.length;
    const routed = `${complete.length}/${total} routed`;
    return open.length > 0 ? `${routed}, ${open.length} open` : routed;
  }
  if (run.status === "failed") return run.error ? `Failed: ${run.error}` : "Failed";
  if (run.status === "cancelled") return "Cancelled";
  if (run.status === "timed_out") return "Timed out";
  if (run.status === "interrupted") return "Interrupted";
  return "Done";
}

export function runDuration(run: RouteRunSummary, now = Date.now()): string {
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return "";
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  return Number.isFinite(end) && end >= start ? formatDuration(end - start) : "";
}

export function describeRun(run: RouteRunSummary, now = Date.now()): RunRow {
  const parts = [
    run.router === "capacity" ? "fab_router" : run.router,
    runDuration(run, now),
    relativeTime(run.startedAt, now),
    run.fallbackReason ? `fallback: ${run.fallbackReason}` : "",
  ].filter(Boolean);
  return {
    id: run.id,
    title: runTitle(run),
    subtitle: parts.join(" · "),
    status: run.status,
    tone: runTone(run.status),
    live: LIVE_STATUSES.has(run.status),
  };
}

/** Newest first, with anything still running on top regardless of when it started. */
export function sortRuns(runs: readonly RouteRunSummary[]): RouteRunSummary[] {
  return [...runs].sort((a, b) => {
    const liveA = LIVE_STATUSES.has(a.status) ? 1 : 0;
    const liveB = LIVE_STATUSES.has(b.status) ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  });
}
