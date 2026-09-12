/**
 * Local notifications (docs/mobile-notifications.md §3.3, roadmap N1): while the app is in the
 * background but its socket is still alive, an `agent.done` / `agent.error` (or a request for
 * approval or input) becomes a notification straight from the phone, with no server involved.
 *
 * `CoreConnection` calls `notifyForEvent` on every event before the shared reducer sees it, so
 * the run store still maps the run to its thread. Text comes from whatever the query cache
 * holds about the thread, its project and the agent — the daemon's push (§4.3) says the same
 * thing, and the dedupe key makes sure the user sees one or the other, never both.
 */
import { useRunsStore } from "@fabdesk/client-core";
import type { DoctorReport, ProjectSummary, Thread } from "@fabdesk/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { AppState } from "react-native";
import {
  dedupeKey,
  noticeForEvent,
  notificationText,
  prefAllows,
  type NotificationData,
  type RunEventLike,
} from "../lib/notification-payload";
import type { Connection } from "../transport/connections";
import { scheduleLocalNotification } from "./local";
import { useNotificationStore } from "./store";

export interface NotifierContext {
  connection: Connection;
  qc: QueryClient;
}

function cachedThread(qc: QueryClient, threadId: string): Thread | undefined {
  const direct = qc.getQueryData<Thread>(["thread", threadId]);
  if (direct) return direct;
  for (const [, list] of qc.getQueriesData<Thread[]>({ queryKey: ["threads"] })) {
    const hit = list?.find((t) => t.id === threadId);
    if (hit) return hit;
  }
  return undefined;
}

function cachedProjectName(
  qc: QueryClient,
  projectId: string | null | undefined,
): string | undefined {
  if (!projectId) return undefined;
  return (
    qc.getQueryData<ProjectSummary>(["project", projectId])?.name ??
    qc.getQueryData<ProjectSummary[]>(["projects"])?.find((p) => p.id === projectId)?.name
  );
}

function agentName(qc: QueryClient, agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  const info = qc.getQueryData<DoctorReport>(["doctor"])?.agents.find((a) => a.id === agentId);
  return info?.displayName ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/**
 * Decides and, when warranted, schedules. Everything that can say no is checked before any
 * cache lookup: foreground, switch off, pref off, not a notifiable event, already shown.
 */
export function notifyForEvent(event: RunEventLike, ctx: NotifierContext): void {
  if (AppState.currentState === "active") return;
  const store = useNotificationStore.getState();
  if (!store.enabled) return;
  const runs = useRunsStore.getState();
  const notice = noticeForEvent(event, (runId) => runs.threadByRun[runId]);
  if (!notice || !prefAllows(store.prefs, notice.kind)) return;

  const coreId = ctx.connection.coreId ?? ctx.connection.id;
  const data: NotificationData = {
    v: 1,
    kind: notice.kind,
    coreId,
    coreName: ctx.connection.name,
    ...(notice.threadId ? { threadId: notice.threadId } : {}),
    ...(notice.runId ? { runId: notice.runId } : {}),
    ...(notice.jobId ? { jobId: notice.jobId } : {}),
  };
  const key = dedupeKey(data);
  if (!key || !store.markSeen(key)) return;

  const thread = notice.threadId ? cachedThread(ctx.qc, notice.threadId) : undefined;
  const job = notice.jobId ? runs.jobs[notice.jobId] : undefined;
  const projectId = thread?.projectId ?? job?.projectId;
  if (projectId) data.projectId = projectId;
  const liveRun = notice.threadId ? runs.runsByThread[notice.threadId] : undefined;
  const text = notificationText(notice.kind, {
    threadTitle: thread?.title,
    agent: agentName(ctx.qc, liveRun?.agentId ?? thread?.agentId),
    project: cachedProjectName(ctx.qc, projectId),
    coreName: ctx.connection.name,
    jobKind: job?.kind,
  });
  void scheduleLocalNotification({ ...text, data }).catch(() => {});
}
