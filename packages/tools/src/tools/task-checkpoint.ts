import { jailPath, writeJson } from "../fs";
import { z } from "zod/v4";
import { defineTool, ToolError } from "../registry";
import {
  compareTaskCheckpoint,
  compactTaskComparison,
  listTaskCheckpoints,
  retainTaskCheckpoint,
  restoreTaskCheckpoint,
  TaskScope,
  taskCheckpointText,
} from "../task-checkpoints";
import { ok } from "./common";

export const project_checkpoint = defineTool({
  name: "project_checkpoint",
  toolset: "project",
  title: "Retain or compare native task checkpoints",
  description:
    "Retain, list, compare or explicitly restore named saved native task checkpoints across route, copper, sync and direct edits. Restore requires checkpointId, reason and expectedRevision from a fresh comparison; preserves displaced saved files and refuses unsaved live conflicts. A baseline stays unchanged when later checkpoints are retained. Comparison is advisory; no native checks, task acceptance or scope inference. project_status shows the baseline comparison.",
  inputSchema: {
    action: z.enum(["retain", "list", "compare", "restore"]),
    name: z.string().min(1).max(100).optional(),
    reason: z.string().min(1).max(1000).optional(),
    role: z.enum(["baseline", "checkpoint"]).default("checkpoint"),
    scope: TaskScope.optional(),
    checkpointId: z
      .string()
      .regex(/^task-[a-z0-9-]+$/)
      .optional(),
    expectedRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  },
  // This operation can retain files, so it is conservatively mutating for every action.
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async ({ action, name, reason, role, scope, checkpointId, expectedRevision }, ctx) => {
    const project = ctx.requireProject();
    if (action === "retain") {
      if (!name || !reason) throw new ToolError("retain requires name and reason", "invalid_args");
      const checkpoint = await retainTaskCheckpoint(
        project,
        { name, reason, role, ...(scope ? { scope } : {}) },
        ctx.services.runtimeId,
      );
      return ok(
        `Retained ${role} ${checkpoint.id}; native checks not run and task acceptance not inferred.`,
        checkpoint,
      );
    }
    if (action === "list")
      return ok("Retained native task checkpoints; no validity or acceptance inferred.", {
        checkpoints: await listTaskCheckpoints(project),
      });
    if (action === "restore") {
      if (!checkpointId || !expectedRevision || !reason)
        throw new ToolError(
          "restore requires checkpointId, expectedRevision and reason",
          "invalid_args",
        );
      const route = ctx.services.routeRuns.latest(project.id);
      if (route && ["queued", "running", "cancel_requested", "cancelling"].includes(route.state))
        throw new ToolError(
          "checkpoint restore refused: routing is active; wait for it to finish",
          "precondition",
        );
      const recovery = ctx.services.design.withSavedFilesRecovery;
      if (!recovery)
        throw new ToolError(
          "native saved-file recovery is unavailable in this runtime",
          "unavailable",
        );
      const restored = await restoreTaskCheckpoint(
        project,
        checkpointId,
        expectedRevision,
        reason,
        ctx.services.runtimeId,
        (replace) => ctx.services.design.withSavedFilesRecovery!(project.dir, replace),
      );
      return ok(
        `Restored ${checkpointId}; displaced saved work retained as ${restored.displacedCheckpointId}. Native checks not run; task acceptance not inferred.`,
        restored,
      );
    }
    const comparison = await compareTaskCheckpoint(project, checkpointId);
    if (!comparison) return ok(taskCheckpointText(comparison), null);
    const report = `.fabdesk/task-checkpoints/comparisons/${comparison.checkpointId}-${comparison.currentRevision}.json`;
    await writeJson(await jailPath(project.dir, report), comparison);
    return ok(taskCheckpointText(comparison), { ...compactTaskComparison(comparison), report });
  },
});
