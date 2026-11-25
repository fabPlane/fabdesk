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
  failed: "Finish it stopped early",
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

/**
 * Why a step ended where it did ("Board not built", "DRC 1 error"). Pending steps have nothing to
 * say yet, and the running step's note is already the panel's summary line.
 */
export function finishItMilestoneNote(session: FinishItSession, milestone: FinishItMilestone): string | null {
  const status = finishItDisplayedMilestoneStatus(session, milestone);
  if (status === "pending" || status === "skipped" || status === "running" || !milestone.note) return null;
  return milestone.note;
}

/** What the user can do after a session that ended with steps left; a new run resumes from the saved project. */
export function finishItNextStep(session: FinishItSession): string | null {
  if (session.status !== "failed" && session.status !== "stopped") return null;
  const unfinished = session.milestones.some((m) => m.status !== "done" && m.status !== "skipped");
  if (!unfinished) return null;
  const kept = session.milestones.some((m) => m.status === "done");
  return kept
    ? "Completed steps are saved. Run Finish it again to continue, or ask the agent about the step that is stuck."
    : "Run Finish it again to retry, or ask the agent about the step that is stuck.";
}
