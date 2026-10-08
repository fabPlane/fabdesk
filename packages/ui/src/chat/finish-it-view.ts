import {
  FINISH_IT_MILESTONE_LABELS,
  type FinishItMilestone,
  type FinishItSession,
  type FinishItStatus,
} from "@fabdesk/protocol";

export const FINISH_IT_STATUS_LABEL: Record<FinishItStatus, string> = {
  running: "Finishing the board",
  stopping: "Stopping…",
  completed: "Board finished",
  stopped: "Finish it stopped",
  failed: "Finish it failed",
};

export function finishItActive(session: FinishItSession | null | undefined): boolean {
  return session?.status === "running" || session?.status === "stopping";
}

export function finishItMilestoneTone(
  status: FinishItMilestone["status"],
): "pending" | "running" | "done" | "failed" {
  if (status === "done" || status === "skipped") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "pending";
}

export function finishItSummary(session: FinishItSession): string {
  const current = session.milestones.find((m) => m.id === session.currentMilestone);
  if (session.status === "failed" && session.error) return session.error;
  if (current?.note) return current.note;
  if (session.currentMilestone) return FINISH_IT_MILESTONE_LABELS[session.currentMilestone];
  return FINISH_IT_STATUS_LABEL[session.status];
}
