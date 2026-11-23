import { z } from "zod/v4";
import { AssemblyRelativePath, BoardSourceSelection, NativeSourceContext } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
import { pcbToolJsonForSource } from "./pcb-parts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ReviewRecord = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/), projectId: z.string().min(1), status: z.string(),
  nativeSource: NativeSourceContext.optional(),
  board: BoardSourceSelection.optional(), sourceDirectory: z.union([z.literal("."), AssemblyRelativePath]).optional(),
  startingPcbRevision: Hash, canonicalMatchesStart: z.boolean(),
  candidate: z.object({ available: z.boolean(), reopenable: z.boolean(), path: z.string(), sha256: Hash.nullable() }),
  application: z.object({ state: z.string(), reason: z.string().nullable() }),
  result: z.object({ state: z.string().optional(), open: z.array(z.string()), quality: z.object({ text: z.string(), warnings: z.array(z.object({ kind: z.string(), text: z.string() })).optional() }).optional() }).nullable(),
});

/** Durable run facts are useful for review; applying still rechecks native source and candidate. */
export function routeRunMatchesSource(run: { projectId: string; board?: BoardSourceSelection | undefined; nativeSource?: NativeSourceContext | undefined }, projectId: string, board?: BoardSourceSelection, nativeSource?: NativeSourceContext | null): boolean {
  return (run.nativeSource?.sourcePath ?? null) === (nativeSource?.sourcePath ?? null) && run.projectId === projectId && (!!run.board === !!board) && (!board || run.board?.sourceId === board.sourceId && run.board.manifestSha256 === board.manifestSha256);
}
type RouteSelectionRecord = { id: string; projectId: string; status: string; board?: BoardSourceSelection | undefined; nativeSource?: NativeSourceContext | undefined };

/** Choose only recorded runs owned by this view; unrelated frames cannot choose a run. */
export function selectOwnedRouteRun(history: readonly RouteSelectionRecord[],
  scope: { projectId: string; board?: BoardSourceSelection | undefined; nativeSource?: NativeSourceContext | null | undefined },
  selection: { currentId: string | null; current?: RouteSelectionRecord | undefined; seen: ReadonlySet<string> | null; followNew: boolean }) {
  const owned = history.filter(row => routeRunMatchesSource(row, scope.projectId, scope.board, scope.nativeSource));
  const currentOwned = selection.currentId && (owned.some(row => row.id === selection.currentId) ||
    selection.current?.id === selection.currentId && routeRunMatchesSource(selection.current, scope.projectId, scope.board, scope.nativeSource));
  if (!currentOwned) return owned[0]?.id ?? null;
  if (selection.followNew && selection.seen) {
    // History is newest first. A short run may already have finished by refresh.
    const newest = owned[0];
    if (newest && !selection.seen.has(newest.id)) return newest.id;
  }
  return selection.currentId;
}
export function parseRouteReview(value: unknown, projectId: string, runId: string, board?: BoardSourceSelection, nativeSource?: NativeSourceContext | null) {
  const run = ReviewRecord.parse(pcbToolJsonForSource(value, projectId, board).run);
  if (run.id !== runId || run.projectId !== projectId) throw new Error("This routing run belongs to another project. Select the run again.");
  if (!routeRunMatchesSource(run, projectId, board, nativeSource) || board && !run.sourceDirectory) throw new Error("This routing run belongs to another board source. Select the run’s recorded source.");
  const candidatePath = `.fabdesk/runs/${run.id}/candidate.kicad_pcb`;
  if (run.candidate.path.replaceAll("\\", "/") !== candidatePath) throw new Error("The route candidate is outside its recorded run directory.");
  const warnings = run.result?.quality?.warnings ?? [];
  const applied = run.application.state === "applied";
  const canApply = run.status === "completed" && run.candidate.available && run.candidate.reopenable && !!run.candidate.sha256 && run.canonicalMatchesStart && ["manual", "pending"].includes(run.application.state) && !warnings.length;
  const reason = applied ? "This candidate was applied. Review the current PCB and rerun its checks." : !run.candidate.available || !run.candidate.reopenable ? "No validated candidate is available for application." : !run.canonicalMatchesStart ? "The saved PCB or routing inputs changed after this run. Create a new candidate from the latest source." : warnings.length ? "Quality warnings need review before this candidate can be applied." : run.application.reason ?? (canApply ? "The saved PCB is unchanged since this run. Apply rechecks its source and candidate before saving." : "This run is not ready for application.");
  const prefix = board && run.sourceDirectory !== "." ? `${run.sourceDirectory}/` : "";
  return { runId, candidatePath: `${prefix}${candidatePath}`, canApply, applied, reason, expectedPcbRevision: run.startingPcbRevision, available: run.candidate.available, resultState: run.result?.state ?? "unverified", openNets: run.result?.open ?? [], quality: run.result?.quality?.text ?? "Routing quality was not recorded.", warnings, applicationState: run.application.state };
}
export type RouteReview = ReturnType<typeof parseRouteReview>;

export async function inspectRouteReview(client: Pick<CoreClient, "callTool"> & Partial<Pick<CoreClient, "nativeSource">>, projectId: string, runId: string, board?: BoardSourceSelection): Promise<RouteReview> {
  return parseRouteReview(await client.callTool("route_status", { projectId, runId, ...(board ? { board: { ...board } } : {}) }), projectId, runId, board, client.nativeSource);
}
