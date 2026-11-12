/**
 * Re-route what an edit cut, in an edit candidate, with the last-mile bench's `finish` step: the candidate folder is
 * the bench's start board, `finish` runs under the usual whole-board gate (fewer opens, no new DRC class, A7/A8 not
 * worse), and the board it accepts is written back over the candidate's board. `board_edit` runs A1-A9 on the result.
 */
import { copyFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Bench, type BenchDeps } from "./bench";
import { figureLine } from "./gate";

export async function repairCandidate(
  deps: BenchDeps,
  o: { candidateDir: string; pcb: string; routeAgain: string[]; actions?: string[] },
): Promise<{ note: string }> {
  const pcb = isAbsolute(o.pcb) ? relative(o.candidateDir, o.pcb) : o.pcb;
  const ws = join(o.candidateDir, ".lastmile"); // skipped by the bench's folder copy
  await rm(ws, { recursive: true, force: true });
  const { bench, line } = await Bench.create(ws, o.candidateDir, pcb, deps, {});
  const start = bench.figures;
  const r = await bench.try(o.actions ?? ["finish"], {});
  const nets = o.routeAgain.length > 6 ? `${o.routeAgain.slice(0, 6).join(", ")} and ${o.routeAgain.length - 6} more` : o.routeAgain.join(", ");
  const done = (note: string) => rm(ws, { recursive: true, force: true }).then(() => ({ note }));
  if (!r.accepted) {
    const why = r.candidates.flatMap((c) => c.rejected).join("; ") || "no candidate";
    return done(`last mile left the board as edited (${why}); nets to route again: ${nets}. ${line}`);
  }
  await copyFile(bench.board, join(o.candidateDir, pcb));
  return done(`last mile ${r.accepted}: open ${start.open} -> ${r.figures.open} (${figureLine(r.figures)}); nets cut by the edit: ${nets}`);
}
