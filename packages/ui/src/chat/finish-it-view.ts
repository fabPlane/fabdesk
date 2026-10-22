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

/** Reports may pass while the agent is still cleaning up or exporting the board. */
function finishingFinalChecks(session: FinishItSession): boolean {
  return finishItActive(session) && session.milestones.length > 0 &&
    session.milestones.every((m) => m.status === "done" || m.status === "skipped");
}

export function finishItDisplayedMilestoneStatus(
  session: FinishItSession,
  milestone: FinishItMilestone,
): FinishItMilestone["status"] {
  if (finishingFinalChecks(session) && milestone.id === "verify") return "running";
  return milestone.status;
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
  if (session.status === "stopping") return "Waiting for the agent to stop…";
  if (session.status === "completed") return "All board checks complete.";
  if (finishingFinalChecks(session)) return "Finishing final checks…";
  const current = session.milestones.find((m) => m.id === session.currentMilestone);
  if (session.status === "failed" && session.error) return session.error;
  if (current?.note) return current.note;
  if (session.currentMilestone) return FINISH_IT_MILESTONE_LABELS[session.currentMilestone];
  return FINISH_IT_STATUS_LABEL[session.status];
}
