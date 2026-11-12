/**
 * The `board` toolset: board workflow tools. This file holds the stage-independent ones; stage tools
 * (check, edit, route, release) are added by later stages and listed in BOARD_TOOLSET_TOOLS.
 */
import { z } from "zod/v4";
import { defineTool, ToolError } from "../registry";
import { getDurableJob, listDurableJobs, durableWaitMs, settled, stillRunning, waitJob } from "../durable";
import { ok } from "./common";

export const board_job = defineTool({
  name: "board_job",
  toolset: "board",
  title: "A long board job: wait, status, cancel",
  description:
    "Board jobs that outlast one call (a long layout stage, edit chain or last-mile try on a large board) keep running and are returned as a job id. wait (default): the job's result when it finishes (waits up to 25 min per call); status: state and latest progress lines; cancel: stop it and its child processes; list: every job in this session of the core.",
  inputSchema: { jobId: z.string().max(80).optional(), action: z.enum(["wait", "status", "cancel", "list"]).default("wait") },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  scope: "global",
  longRunning: true,
  handler: async ({ jobId, action }, ctx) => {
    if (action === "list") {
      const rows = listDurableJobs().map((j) => ({ id: j.id, tool: j.tool, state: j.state, seconds: Math.round((Date.now() - j.startedAt) / 1000) }));
      return ok(rows.map((r) => `${r.id} ${r.tool} ${r.state} ${r.seconds} s`).join("\n") || "no board jobs", { jobs: rows });
    }
    const job = jobId ? getDurableJob(jobId) : undefined;
    if (!job) throw new ToolError(`no board job ${jobId ?? ""} (board_job {action: "list"})`, "not_found");
    if (action === "cancel") {
      job.controller.abort();
      await waitJob(job, 15_000);
      return ok(`job ${job.id}: ${job.state}`, { jobId: job.id, state: job.state });
    }
    if (action === "status" || job.state !== "running") return job.state === "running" ? stillRunning(job) : settled(job);
    return (await waitJob(job, durableWaitMs(), ctx.signal)) ? settled(job) : stillRunning(job);
  },
});

export const boardTools = [board_job];
