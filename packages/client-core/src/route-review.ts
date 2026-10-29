import { z } from "zod/v4";
import type { CoreClient } from "./CoreClient";
import { pcbToolJson } from "./pcb-parts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ReviewRecord = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/), projectId: z.string().min(1), status: z.string(),
  startingPcbRevision: Hash, canonicalMatchesStart: z.boolean(),
  candidate: z.object({ available: z.boolean(), reopenable: z.boolean(), path: z.string(), sha256: Hash.nullable() }),
  application: z.object({ state: z.string(), reason: z.string().nullable() }),
  result: z.object({ state: z.string().optional(), open: z.array(z.string()), quality: z.object({ text: z.string(), warnings: z.array(z.object({ kind: z.string(), text: z.string() })).optional() }).optional() }).nullable(),
});

/** Durable run facts are useful for review; applying still rechecks native source and candidate. */
export function parseRouteReview(value: unknown, projectId: string, runId: string) {
  const run = ReviewRecord.parse(pcbToolJson(value).run);
  if (run.id !== runId || run.projectId !== projectId) throw new Error("This routing run belongs to another project. Select the run again.");
  const candidatePath = `.fabdesk/runs/${run.id}/candidate.kicad_pcb`;
  if (run.candidate.path !== candidatePath) throw new Error("The route candidate is outside its recorded run directory.");
  const warnings = run.result?.quality?.warnings ?? [];
  const applied = run.application.state === "applied";
  const canApply = run.status === "completed" && run.candidate.available && run.candidate.reopenable && !!run.candidate.sha256 && run.canonicalMatchesStart && ["manual", "pending"].includes(run.application.state) && !warnings.length;
  const reason = applied ? "This candidate was applied. Review the current PCB and rerun its checks." : !run.candidate.available || !run.candidate.reopenable ? "No validated candidate is available for application." : !run.canonicalMatchesStart ? "The saved PCB changed after this run. Create a new candidate from the latest source." : warnings.length ? "Quality warnings need review before this candidate can be applied." : run.application.reason ?? (canApply ? "The saved PCB is unchanged since this run. Apply rechecks its source and candidate before saving." : "This run is not ready for application.");
  return { runId, candidatePath, canApply, applied, reason, expectedPcbRevision: run.startingPcbRevision, available: run.candidate.available, resultState: run.result?.state ?? "unverified", openNets: run.result?.open ?? [], quality: run.result?.quality?.text ?? "Routing quality was not recorded.", warnings, applicationState: run.application.state };
}
export type RouteReview = ReturnType<typeof parseRouteReview>;

export async function inspectRouteReview(client: Pick<CoreClient, "callTool">, projectId: string, runId: string): Promise<RouteReview> {
  return parseRouteReview(await client.callTool("route_status", { projectId, runId }), projectId, runId);
}
