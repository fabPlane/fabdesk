/**
 * The `board` toolset: board workflow tools. This file holds the stage-independent one (`board_job`); the stage tools
 * (board_check, board_route, board_edit, board_review, board_silk, board_release) live in board-*.ts and are listed in
 * BOARD_TOOLSET_TOOLS.
 */
import { z } from "zod/v4";
import { defineTool, ToolError } from "../registry";
import { cancelDurableJob, getDurableJob, listDurableJobs, durableWaitMs, settled, stillRunning, unknownJobReason, waitJob } from "../durable";
import { ok } from "./common";

export const board_job = defineTool({
  name: "board_job",
  toolset: "board",
  title: "A long board job: wait, status, cancel",
  description:
    "Board jobs that outlast one call (a long layout stage, edit chain or last-mile try on a large board) keep running and are returned as a job id. wait (default): the job's result when it finishes (waits up to 25 min per call); status: state and latest progress lines; cancel: stop it and its child processes, reporting how it ended (or 'stopping' if it has not yet); list: this project's jobs (allProjects: every project's, read-only). Jobs belong to the project they were started in; finished jobs are kept for an hour (the newest 50), and jobs live in the daemon's memory, so an id from before a daemon restart is unknown.",
  inputSchema: {
    jobId: z.string().max(80).optional(),
    action: z.enum(["wait", "status", "cancel", "list"]).default("wait"),
    allProjects: z.boolean().default(false).describe("list: every project's jobs (ids, tools, states), not only this project's."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  scope: "global",
  longRunning: true,
  handler: async ({ jobId, action, allProjects }, ctx) => {
    // the calling project's jobs only (a global tool: the project is the run's or the session's default)
    const projectId = ctx.project?.id ?? null;
    if (action === "list") {
      const rows = listDurableJobs(allProjects ? undefined : projectId).map((j) => ({ id: j.id, tool: j.tool, state: j.state, projectId: j.projectId, seconds: Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000) }));
      return ok(rows.map((r) => `${r.id} ${r.tool} ${r.state} ${r.seconds} s${allProjects ? ` (project ${r.projectId ?? "none"})` : ""}`).join("\n") || "no board jobs", { jobs: rows });
    }
    if (!jobId) throw new ToolError(`${action} needs jobId (board_job {"action": "list"})`, "invalid_args");
    const job = getDurableJob(jobId);
    if (!job) throw new ToolError(unknownJobReason(jobId), "not_found");
    if (job.projectId !== projectId) throw new ToolError(`board job ${jobId} belongs to another project; call board_job from that project`, "not_found");
    if (action === "cancel") {
      const c = await cancelDurableJob(job);
      const text = c.already
        ? `job ${job.id} had already ended: ${c.state} (nothing to cancel)`
        : c.state === "stopping"
          ? `job ${job.id}: cancel requested, still stopping after 15 s; board_job {"jobId": "${job.id}", "action": "status"} reports when it ends`
          : `job ${job.id}: ${c.state}${c.state === "done" ? " (it finished before the cancel took effect; its result stands)" : ""}`;
      return ok(text, { jobId: job.id, state: c.state, alreadyEnded: c.already });
    }
    if (action === "status" || job.state !== "running") return job.state === "running" ? stillRunning(job) : settled(job);
    return (await waitJob(job, durableWaitMs(ctx), ctx.signal)) ? settled(job) : stillRunning(job);
  },
});

export const boardTools = [board_job];
