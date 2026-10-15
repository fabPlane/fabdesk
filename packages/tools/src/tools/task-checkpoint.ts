import { jailPath, writeJson } from "../fs";
import { z } from "zod/v4";
import { defineTool, ToolError } from "../registry";
import { compareTaskCheckpoint, compactTaskComparison, listTaskCheckpoints, retainTaskCheckpoint, TaskScope, taskCheckpointText } from "../task-checkpoints";
import { ok } from "./common";

export const project_checkpoint = defineTool({
  name: "project_checkpoint", toolset: "project", title: "Retain or compare native task checkpoints",
  description: "Retain named saved native files and explicit task scope across route, copper, sync and direct edits, or list/compare retained checkpoints. A baseline stays unchanged when later checkpoints are retained. Comparison is advisory; no native checks, task acceptance, scope inference or restore is performed. project_status shows the baseline comparison.",
  inputSchema: {
    action: z.enum(["retain", "list", "compare"]),
    name: z.string().min(1).max(100).optional(), reason: z.string().min(1).max(1000).optional(),
    role: z.enum(["baseline", "checkpoint"]).default("checkpoint"), scope: TaskScope.optional(),
    checkpointId: z.string().regex(/^task-[a-z0-9-]+$/).optional(),
  },
  // This operation can retain files, so it is conservatively mutating for every action.
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  handler: async ({ action, name, reason, role, scope, checkpointId }, ctx) => {
    const project = ctx.requireProject();
    if (action === "retain") {
      if (!name || !reason) throw new ToolError("retain requires name and reason", "invalid_args");
      const checkpoint = await retainTaskCheckpoint(project, { name, reason, role, ...(scope ? { scope } : {}) }, ctx.services.runtimeId);
      return ok(`Retained ${role} ${checkpoint.id}; native checks not run and task acceptance not inferred.`, checkpoint);
    }
    if (action === "list") return ok("Retained native task checkpoints; no validity or acceptance inferred.", { checkpoints: await listTaskCheckpoints(project) });
    const comparison = await compareTaskCheckpoint(project, checkpointId);
    if (!comparison) return ok(taskCheckpointText(comparison), null);
    const report = `.fabdesk/task-checkpoints/comparisons/${comparison.checkpointId}-${comparison.currentRevision}.json`;
    await writeJson(await jailPath(project.dir, report), comparison);
    return ok(taskCheckpointText(comparison), { ...compactTaskComparison(comparison), report });
  },
});
