/** One-click autonomous "Finish it" session: take a partial board to manufacturable. */
import { z } from "zod/v4";

export const FinishItMilestoneId = z.enum(["schematic", "build", "route", "verify", "review"]);
export type FinishItMilestoneId = z.infer<typeof FinishItMilestoneId>;

export const FINISH_IT_MILESTONES: readonly FinishItMilestoneId[] = [
  "schematic",
  "build",
  "route",
  "verify",
  // only planned when the board toolkit is in use on the project
  "review",
] as const;

export const FINISH_IT_MILESTONE_LABELS: Record<FinishItMilestoneId, string> = {
  schematic: "Finish schematic",
  build: "Place footprints",
  route: "Route copper",
  verify: "Verify DRC / ERC / SPICE",
  review: "Review and settle findings",
};

export const FinishItMilestoneState = z.enum(["pending", "running", "done", "skipped", "failed"]);
export type FinishItMilestoneState = z.infer<typeof FinishItMilestoneState>;

export const FinishItStatus = z.enum([
  "running",
  "stopping",
  "completed",
  "stopped",
  "failed",
]);
export type FinishItStatus = z.infer<typeof FinishItStatus>;

export const FinishItCommit = z.object({
  milestone: FinishItMilestoneId,
  sha: z.string(),
  message: z.string(),
  at: z.string(),
});
export type FinishItCommit = z.infer<typeof FinishItCommit>;

export const FinishItMilestone = z.object({
  id: FinishItMilestoneId,
  label: z.string(),
  status: FinishItMilestoneState,
  note: z.string().optional(),
  commitSha: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});
export type FinishItMilestone = z.infer<typeof FinishItMilestone>;

export const FinishItSession = z.object({
  id: z.string(),
  projectId: z.string().min(1),
  threadId: z.string(),
  runId: z.string().nullable(),
  status: FinishItStatus,
  currentMilestone: FinishItMilestoneId.nullable(),
  milestones: z.array(FinishItMilestone),
  commits: z.array(FinishItCommit),
  error: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type FinishItSession = z.infer<typeof FinishItSession>;

export const FinishItResponse = z.object({
  session: FinishItSession.nullable(),
  needsWork: z.boolean().optional(),
});
export type FinishItResponse = z.infer<typeof FinishItResponse>;
