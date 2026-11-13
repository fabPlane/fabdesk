/**
 * Re-route what an edit cut, in an edit candidate, with the last-mile bench, in the toolkit's editbench order
 * (`flow/editbench.py run`): `finish`; if the edit made the pairs worse, `pairs` + `pairs-all`; then, while opens or
 * A7 failures remain, least invasive first: `taps`, `a7`, `leg`, then `rip` + `blockers:1.0`. Every step runs under
 * the bench's whole-board gate (fewer opens, no new DRC class, A7/A8 not worse); the board the bench ends on is
 * written over the candidate's board. `board_edit` runs A1-A9 on the result.
 *
 * The workspace stays in the candidate (`.lastmile`, skipped by the bench's folder copy and by adopt) so the agent can
 * look at it afterwards with `board_route` (`info`, `view`, `why`, `try`) by naming it as the workspace.
 */
import { copyFile, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Bench, type BenchDeps } from "./bench";
import { figureLine, type Figures } from "./gate";

/** Seconds per step, as editbench passes `--budget 600`. */
const STEP_BUDGET_S = 600;

/** The chain editbench runs after `finish` (and pairs), decided once from the figures at that point. */
export function repairStages(f: Figures): string[][] {
  return [f.open ? ["taps"] : [], f.a7 ? ["a7"] : [], f.open ? ["leg"] : [], ["rip", "blockers:1.0"]].filter((s) => s.length);
}

/**
 * A source board with this many open connections before the edit was not routed yet (a placed board on its way to
 * layout): the edit's repair would route the whole board inside the edit (an s7-whole run spent 16 minutes there and
 * the agent cancelled it). editbench only ever repairs routed boards; routing a placed board is board_route's job.
 */
export const UNROUTED_OPENS = 20;

async function before(candidateDir: string): Promise<{ a8: number; open: number | null }> {
  const rec = JSON.parse(await readFile(join(candidateDir, "before-acceptance.json"), "utf8").catch(() => "{}")) as {
    results?: { A8_pairs?: { nets_failing?: number }; A1_connectivity?: { unconnected?: number } };
  };
  const open = rec.results?.A1_connectivity?.unconnected;
  return { a8: rec.results?.A8_pairs?.nets_failing ?? 0, open: typeof open === "number" ? open : null };
}

export interface RepairStep {
  try: string[];
  accepted: string | null;
  open: number;
  /** First rejection reason when nothing was kept. */
  why?: string;
  /** Seconds the try took, and its last line (`now   step 1: ...`), as editbench records them. */
  wall_s: number;
  out: string[];
}

export async function repairCandidate(
  deps: BenchDeps,
  o: { candidateDir: string; pcb: string; routeAgain: string[]; actions?: string[]; projectDir?: string },
): Promise<{ note: string; workspace: string; steps: RepairStep[]; start: { line: string; wall_s: number } }> {
  const pcb = isAbsolute(o.pcb) ? relative(o.candidateDir, o.pcb) : o.pcb;
  const prior = await before(o.candidateDir);
  if (!o.actions && prior.open !== null && prior.open >= UNROUTED_OPENS) {
    const nets = o.routeAgain.length > 6 ? `${o.routeAgain.slice(0, 6).join(", ")} and ${o.routeAgain.length - 6} more` : o.routeAgain.join(", ");
    const note = `last mile skipped: the board had ${prior.open} open connections before the edit (not routed yet), so routing it is board_route's job (layout check/route, then the last mile), not the edit's; the edit's nets (${nets || "none"}) are among the opens it will route.`;
    return { note, workspace: "", steps: [], start: { line: `not routed before the edit (open ${prior.open})`, wall_s: 0 } };
  }
  const ws = join(o.candidateDir, ".lastmile"); // skipped by the bench's folder copy
  await rm(ws, { recursive: true, force: true });
  const t0 = Date.now();
  const { bench, line } = await Bench.create(ws, o.candidateDir, pcb, deps, {});
  const secs = (since: number) => Math.round((Date.now() - since) / 100) / 10;
  const startRec = { line, wall_s: secs(t0) };
  const start = bench.figures;
  const a8b = prior.a8;
  const steps: RepairStep[] = [];
  const run = async (actions: string[]) => {
    const t = Date.now();
    const r = await bench.try(actions, { budget: STEP_BUDGET_S });
    const why = r.accepted ? undefined : r.candidates.flatMap((c) => c.rejected)[0];
    steps.push({ try: actions, accepted: r.accepted, open: bench.figures.open, ...(why ? { why: why.slice(0, 120) } : {}), wall_s: secs(t), out: r.lines.slice(-1) });
  };
  const needs = (f: Figures) => f.open > 0 || f.a7 > 0;
  if (o.actions) await run(o.actions);
  else if (needs(start) || start.a8 > a8b) {
    await run(["finish"]);
    if (bench.figures.a8 > a8b) await run(["pairs", "pairs-all"]); // the edit cut a pair: route it again as a pair
    for (const stage of repairStages(bench.figures)) if (needs(bench.figures)) await run(stage);
  }
  const kept = steps.some((s) => s.accepted);
  if (kept) await copyFile(bench.board, join(o.candidateDir, pcb));
  const end = bench.figures;
  const shown = o.projectDir ? relative(o.projectDir, ws).split("\\").join("/") : ws;
  const nets = o.routeAgain.length > 6 ? `${o.routeAgain.slice(0, 6).join(", ")} and ${o.routeAgain.length - 6} more` : o.routeAgain.join(", ");
  const trail = steps.map((s) => `${s.try.join("+")}: ${s.accepted ? `kept, open ${s.open}` : `nothing kept${s.why ? ` (${s.why})` : ""}`}`).join("; ");
  const head = kept ? `last mile: open ${start.open} -> ${end.open} (${figureLine(end)})` : `last mile left the board as edited (open ${start.open})`;
  const note = `${head}; steps: ${trail || "none needed"}; nets cut by the edit: ${nets || "none"}. Workspace ${shown} (board_route info/view/why with workspace=${shown}).`;
  return { note, workspace: shown, steps, start: startRec };
}
