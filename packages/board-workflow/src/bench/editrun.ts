/**
 * `editbench run PLAN OUT [--heldout]` (toolkit flow/editbench.py `run`): one edit task through the edit stage as
 * board_edit runs it (`runEdit` mode full: impact, apply, the last-mile repair of what the edit cut, A1-A9 proof, churn
 * guard), timed per phase, written as the toolkit's `result.json` so `editTable` (`bench.ts edit-table`) reads Fabdesk
 * runs and toolkit runs alike.
 *
 * The run works on a copy of the plan's project under OUT/project (the toolkit's edit.py wrote its candidate to OUT/eco;
 * runEdit writes its candidate inside the project), so the source project is never touched.
 *
 * Fields and their meaning are the toolkit's: phases (impact, apply, bench_new, repair, proof, guard, diff, seconds),
 * impact_verdict, after_edit (the repair bench's start line), repair_steps (try, wall_s, last line), churn_guard,
 * final (A1-A9), final_detail (open, drc, a7, a8), verdict ("PASS all A1-A9 with parity" / "FAIL A..."; held-out:
 * "PASS (no regression)" / "FAIL regress [...]"; "STOP impact"; "FAIL apply: ..."), churn (unplanned_moved,
 * collateral_nets, collateral_mm, planned_nets, collateral_top: the 8 collateral nets that changed most), total_s.
 * One difference in when the bench runs: the toolkit opened a bench on every edited board and repaired when it had
 * opens, A7 failures or more A8 nets; the edit stage repairs when the edit cut nets (an edit that cuts nothing records
 * no bench_new / after_edit).
 */
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BOARD_DIR } from "../files";
import { churn, diffBoards } from "../edit/diff";
import { runEdit, type EditRunners, type EditRunResult } from "../edit/pipeline";
import type { RepairStep } from "../lastmile/repair";

/** Top-level project entries the copy leaves out (heavy, and not read by an edit). */
const SKIP = /^(\.git|\.fabdesk|node_modules|.*\.(pdf|png|step|stp|wrl|zip)|.*-backups|_autosave.*|.*\.lck)$/;

/** Copy a project for a bench run: its files, and of `.fabdesk/board` the onboarding record, requirements and cached before-scores. */
export async function copyProjectForBench(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) if (!SKIP.test(e.name)) await cp(join(src, e.name), join(dst, e.name), { recursive: true });
  const bd = join(src, BOARD_DIR);
  for (const e of await readdir(bd, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile()) await cp(join(bd, e.name), join(dst, BOARD_DIR, e.name));
    else if (e.name === "requirements") await cp(join(bd, e.name), join(dst, BOARD_DIR, e.name), { recursive: true });
  }
  await cp(join(bd, "edits", ".before"), join(dst, BOARD_DIR, "edits", ".before"), { recursive: true }).catch(() => {});
}

type Summary = Record<string, boolean>;
interface Judged {
  summary: Summary;
  results?: { A8_pairs?: { nets_failing?: number } };
}

const pyList = (l: string[]) => `[${l.map((s) => `'${s}'`).join(", ")}]`;

/** The toolkit's verdict string (editbench run), from the unedited and the final A1-A9. */
export function editBenchVerdict(final: Summary, finalA8: number, before: Judged, heldout: boolean): string {
  if (heldout) {
    const worse: string[] = Object.entries(final).filter(([k, v]) => !v && before.summary[k]).map(([k]) => k);
    const a8b = before.results?.A8_pairs?.nets_failing ?? 0;
    if (!final["A8_pairs"] && !before.summary["A8_pairs"] && finalA8 > a8b) worse.push(`A8 ${a8b}->${finalA8}`);
    const ok = !worse.length && final["A1_connectivity"] && final["A2_drc"] && final["A3_parity"];
    return ok ? "PASS (no regression)" : `FAIL regress ${pyList(worse)}`;
  }
  const failing = Object.entries(final).filter(([, v]) => !v).map(([k]) => k);
  return failing.length ? "FAIL " + failing.join(",") : "PASS all A1-A9 with parity";
}

/** time.strftime('%Y-%m-%dT%H:%M:%S'), local time. */
export function pyLocalStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface EditRunBenchOptions {
  planPath: string;
  out: string;
  heldout?: boolean;
  /** Plans name their project relative to this folder (the toolkit's PROJECT); default the current directory. */
  root?: string;
  /** Hash of the chain's source files (the toolkit's tool_version). */
  toolVersion: string;
  /** A1-A9 with schematic parity on a project folder. */
  accept: EditRunners["accept"];
  /** The last-mile repair of an edit candidate (`repairCandidate` with the bench's deps). */
  repair: (i: { candidateDir: string; pcb: string; routeAgain: string[] }) => Promise<{ note: string; steps: RepairStep[]; start: { line: string; wall_s: number } }>;
  log?: (line: string) => void;
  now?: () => Date;
}

/** One editbench run: writes OUT/result.json and returns it. */
export async function runEditBench(o: EditRunBenchOptions): Promise<Record<string, unknown>> {
  const planPath = resolve(o.planPath);
  const out = resolve(o.out);
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown> & { id: string; board?: string; project?: string };
  await mkdir(out, { recursive: true });
  const t0 = Date.now();
  const secs = (since: number) => Math.round((Date.now() - since) / 100) / 10;
  const phases: Record<string, number> = {};
  const res: Record<string, unknown> = { plan: planPath, id: plan.id, tool_version: o.toolVersion, phases, started: pyLocalStamp((o.now ?? (() => new Date()))()) };
  const write = async () => {
    await writeFile(join(out, "result.json"), JSON.stringify(res, null, 1) + "\n");
    return res;
  };
  const where = String(plan.project ?? plan.board ?? "");
  const src = isAbsolute(where) ? where : resolve(o.root ?? process.cwd(), where);
  const proj = join(out, "project");
  await copyProjectForBench(src, proj);
  let rep: Awaited<ReturnType<EditRunBenchOptions["repair"]>> | null = null;
  const r: EditRunResult = await runEdit({
    projectDir: proj,
    plan,
    mode: "full",
    runners: {
      accept: o.accept,
      repair: async (i) => (rep = await o.repair(i)),
      ...(o.log ? { progress: (_p: number, note: string) => o.log!(note) } : {}),
    },
  });
  const coordinates = r.agentCoordinates;
  phases["impact"] = r.phases["impact"] ?? 0;
  Object.assign(res, { agent_coordinates: coordinates, interventions: 0, impact_verdict: r.impactLines.at(-1) ?? r.impact.verdict });
  if (r.stage === "impact") {
    Object.assign(res, { verdict: "STOP impact", total_s: secs(t0) });
    return write();
  }
  phases["apply"] = r.phases["apply"] ?? 0;
  if (r.stage === "apply") {
    Object.assign(res, { verdict: `FAIL apply: ${r.verdict.slice(0, 200)}`, total_s: secs(t0) });
    return write();
  }
  const repaired = rep as Awaited<ReturnType<EditRunBenchOptions["repair"]>> | null;
  if (repaired) {
    phases["bench_new"] = repaired.start.wall_s;
    res["after_edit"] = repaired.start.line;
  }
  const steps = (repaired?.steps ?? []).map((s) => ({ try: s.try, wall_s: s.wall_s, out: s.out }));
  phases["repair"] = Math.round(steps.reduce((t, s) => t + s.wall_s, 0) * 10) / 10;
  res["repair_steps"] = steps;
  phases["proof"] = r.phases["proof"] ?? 0;
  if (r.guard) res["churn_guard"] = { nets: r.guard.nets, kept: r.guard.kept };
  phases["guard"] = r.phases["guard"] ?? 0;
  const proof = r.proof!;
  res["final"] = proof.after;
  res["final_detail"] = { open: proof.figures.open, drc: proof.figures.drc, a7: proof.figures.a7, a8: proof.figures.a8 };
  const cand = r.candidate!.dir;
  const before = JSON.parse(await readFile(join(cand, "before-acceptance.json"), "utf8")) as Judged;
  res["verdict"] = editBenchVerdict(proof.after, proof.figures.a8 ?? 0, before, !!o.heldout);
  // the toolkit's diff phase: planned vs collateral between the source board and the proven one
  const t = Date.now();
  const pcbName = r.candidate!.pcb.slice(cand.length + 1);
  const ledger = JSON.parse(await readFile(join(cand, "edit.json"), "utf8"));
  const ch = churn(diffBoards(await readFile(join(cand, "before", pcbName), "utf8"), await readFile(r.candidate!.pcb, "utf8")), ledger);
  phases["diff"] = secs(t);
  const top = Object.entries(ch.collateral_detail).sort((a, b) => Math.abs(b[1][1] - b[1][0]) - Math.abs(a[1][1] - a[1][0])).slice(0, 8);
  res["churn"] = { unplanned_moved: ch.unplanned_moved, collateral_nets: ch.collateral_nets, collateral_mm: ch.collateral_mm, planned_nets: ch.planned_nets, collateral_top: Object.fromEntries(top) };
  res["candidate"] = cand;
  res["total_s"] = secs(t0);
  return write();
}
