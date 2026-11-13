/**
 * The ECO pipeline: impact (what it touches; STOP = a decision) -> apply (score the unedited project, change board and
 * schematic, copy and edit the requirements) -> repair hook (the route stage's job; absent, the candidate keeps its
 * measured opens) -> A1-A9 proof against the project's baseline -> planned-vs-collateral diff.
 * The candidate is a folder with `origin.json` ({ project, files: {name: sha256} }) beside its board, which
 * `adoptCandidate` reads to write it into the project.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AcceptRun } from "../history";
import { figures } from "../accept";
import { acceptDir, type AcceptIndexEntry } from "../history";
import { BOARD_DIR, designHash, exists, readJson, writeJsonFile } from "../files";
import type { Comparison } from "../history";
import { applyEdit, type ApplyLog, type Scored } from "./apply";
import { churn, diffBoards, revertNets, type BoardDiff, type Churn } from "./diff";
import { loadEditEnv, type EditEnv } from "./env";
import { fillAddDefaults, impact, impactLines, type ImpactReport } from "./impact";
import { coordinatesInPlan, parsePlan, type EditPlan } from "./plan";
import { judge, type Judgement } from "./proof";
import { EditStop } from "./sch";

export type EditMode = "impact" | "apply" | "proof" | "full";

/** What the route stage receives when it repairs a candidate. */
export interface RepairInput {
  candidateDir: string;
  pcb: string;
  /** Nets whose copper the edit cut or deleted: the connections to route again. */
  routeAgain: string[];
  ledger: { plan: EditPlan; impact: ImpactReport; applied: ApplyLog };
}

export interface EditRunners {
  /** A1-A9 on a project folder, recorded in that folder's history (`runAcceptance` with a DRC provider). */
  accept(dir: string, pcb: string): Promise<AcceptRun>;
  /**
   * The hook where the route stage plugs in: re-route what the edit opened, in the candidate, before the proof.
   * Absent, the candidate keeps its measured opens and the proof reports them.
   */
  repair?(input: RepairInput): Promise<{ note: string } | null>;
  progress?(fraction: number, note: string): void;
}

export interface EditRunInput {
  projectDir: string;
  plan: unknown;
  mode?: EditMode;
  pcb?: string;
  /** For mode "proof": the candidate folder (default: the newest candidate of this plan id). */
  candidate?: string;
  runners: EditRunners;
  now?: () => Date;
}

export interface EditRunResult {
  mode: EditMode;
  planId: string;
  /** PASS / STOP / FAIL line of the furthest stage reached. */
  verdict: string;
  stage: "impact" | "apply" | "proof";
  /** True when a decision is needed (STOP) rather than a failure. */
  stop: boolean;
  impact: ImpactReport;
  impactLines: string[];
  candidate?: { dir: string; pcb: string; origin: string };
  applied?: ApplyLog;
  repair?: { available: boolean; note?: string; routeAgain: string[] };
  proof?: Judgement & { id: string; record: string; comparison: ComparisonView | null; before: Record<string, boolean>; after: Record<string, boolean> };
  diff?: BoardDiff;
  churn?: Churn;
  /** The churn guard: collateral nets given their source copper back; kept when the board scored no worse. */
  guard?: { nets: string[]; kept: boolean; why?: string };
  agentCoordinates: number;
  phases: Record<string, number>;
}

export interface ComparisonView {
  label: string;
  newFailures: string[];
  changes: Array<{ code: string; name: string; before: string; now: string; change: string }>;
}

const DESIGN_FILE = /\.(kicad_sch|kicad_sym)$|^(sym|fp)-lib-table$/;

/** sha256 of every design file directly in `dir` (what `adoptCandidate` compares). */
export async function designFileHashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort())
    if (DESIGN_FILE.test(name)) out[name] = createHash("sha256").update(await readFile(join(dir, name))).digest("hex");
  return out;
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");
export const editsDir = (projectDir: string) => join(projectDir, BOARD_DIR, "edits");

async function newestCandidate(projectDir: string, id: string): Promise<string | null> {
  const names = (await readdir(editsDir(projectDir)).catch(() => [] as string[])).filter((n) => n.startsWith(`${id}-`)).sort();
  return names.length ? join(editsDir(projectDir), names[names.length - 1]!) : null;
}

function view(c: Comparison | null): ComparisonView | null {
  if (!c) return null;
  return {
    label: c.against,
    newFailures: [...c.newFailures],
    changes: c.deltas.map((d) => ({ code: d.code, name: d.name, before: d.before.pass ? "pass" : `fail(${d.before.figure})`, now: d.now.pass ? "pass" : `fail(${d.now.figure})`, change: d.change })),
  };
}

/** Bump when the scoring basis changes (DRC flags, check set): cached before-scores are then recomputed. */
export const SCORE_BASIS = "drc-error-parity-v1";

/**
 * Score the unedited copy. The result is cached by design hash under `.fabdesk/board/edits/.before/` (every edit of one
 * source starts from the same score); the candidate's own history is seeded with it so the after-run compares with it.
 */
async function beforeScore(env: EditEnv, copy: string, runners: EditRunners): Promise<{ scored: Scored; cached?: string }> {
  const dh = (await designHash(copy)).design;
  const cache = join(editsDir(env.projectDir), ".before", createHash("sha256").update(`${SCORE_BASIS}:${dh}`).digest("hex").slice(0, 24));
  const seed = async (entry: AcceptIndexEntry, result: unknown) => {
    const dir = acceptDir(copy);
    await mkdir(dir, { recursive: true });
    await writeJsonFile(join(copy, entry.file), result);
    await writeJsonFile(join(dir, "index.json"), [entry]);
  };
  const hit = await readJson<{ entry: AcceptIndexEntry; result: Scored }>(join(cache, "before.json")).catch(() => null);
  if (hit?.result?.summary && hit.result.results) {
    await seed(hit.entry, hit.result);
    return { scored: hit.result, cached: hit.entry.id };
  }
  const run = await runners.accept(copy, env.pcbName);
  await writeJsonFile(join(cache, "before.json"), { entry: run.entry, result: run.result });
  return { scored: run.result };
}

export async function runEdit(input: EditRunInput): Promise<EditRunResult> {
  const mode = input.mode ?? "full";
  const plan = parsePlan(input.plan);
  const t0 = Date.now();
  const phases: Record<string, number> = {};
  const lap = (k: string, since: number) => void (phases[k] = Math.round((Date.now() - since) / 100) / 10);
  const say = (p: number, note: string) => input.runners.progress?.(p, note);
  const env = await loadEditEnv(input.projectDir, input.pcb);
  const base = { mode, planId: plan.id, agentCoordinates: coordinatesInPlan(plan), phases };
  if (mode === "proof") return proofOnly(input, plan, env, base);
  say(0.05, "impact");
  let t = Date.now();
  let rep: ImpactReport;
  try {
    fillAddDefaults(plan, env.pcbText);
    rep = impact(plan, env);
  } catch (e) {
    if (!(e instanceof EditStop)) throw e;
    rep = { id: plan.id, board: "", missing_refs: [], parts: {}, nets: {}, unconnected_pins: [], cascade_candidates: [], copper: { delete_on_nets: [], delete_mm: 0, delete_vias: 0, prune_on_nets: [] }, requirements: {}, contracts: [], schematic: [], review: [], identity: [], verdict: e.message };
  }
  lap("impact", t);
  const stopped = !rep.verdict.startsWith("PASS");
  const common = { ...base, impact: rep, impactLines: impactLines(rep) };
  if (mode === "impact" || stopped)
    return { ...common, stage: "impact", verdict: rep.verdict, stop: stopped && /^STOP/.test(rep.verdict) };
  // apply
  const out = join(editsDir(env.projectDir), `${plan.id}-${stamp((input.now ?? (() => new Date()))())}`);
  t = Date.now();
  say(0.15, "scoring the unedited project, then applying the edit");
  let applied: Awaited<ReturnType<typeof applyEdit>>;
  const projectHashes = await designFileHashes(env.projectDir);
  try {
    applied = await applyEdit(plan, env, out, { score: async (d) => (await input.runners.accept(d, env.pcbName)).result, beforeScored: (d) => beforeScore(env, d, input.runners) });
  } catch (e) {
    if (!(e instanceof EditStop)) throw e;
    return { ...common, stage: "apply", verdict: e.message, stop: /^STOP/.test(e.message) };
  }
  lap("apply", t);
  const pcb = join(out, env.pcbName);
  await writeJsonFile(join(out, "origin.json"), { project: env.projectDir, files: projectHashes });
  await mkdir(dirname(join(out, "before", env.pcbName)), { recursive: true });
  await writeFile(join(out, "before", env.pcbName), env.pcbText);
  const ledger = { plan, impact: rep, applied: applied.log };
  const routeAgain = [...new Set([...(applied.log.moves?.cut_nets ?? []), ...(applied.log.landing?.cut_nets ?? []), ...(applied.log.pad_cut?.cut_nets ?? [])])].sort();
  const candidate = { dir: out, pcb, origin: join(out, "origin.json") };
  if (mode === "apply") return { ...common, stage: "apply", verdict: "PASS apply", stop: false, candidate, applied: applied.log, repair: { available: !!input.runners.repair, routeAgain }, ...(await diffOnly(env.pcbText, applied.pcbText, ledger)) };
  return finish({ ...common, candidate, applied: applied.log }, env, plan, ledger, routeAgain, input, t0);
}

async function diffOnly(before: string, after: string, ledger: { plan: EditPlan; impact: ImpactReport; applied: ApplyLog }) {
  const d = diffBoards(before, after);
  return { diff: d, churn: churn(d, ledger) };
}

type Partial0 = Omit<EditRunResult, "stage" | "verdict" | "stop" | "proof" | "diff" | "churn" | "repair"> & { candidate: NonNullable<EditRunResult["candidate"]>; applied: ApplyLog };

/** Repair hook, A1-A9 proof against the project before the edit, diff. */
async function finish(
  base: Partial0,
  env: EditEnv,
  plan: EditPlan,
  ledger: { plan: EditPlan; impact: ImpactReport; applied: ApplyLog },
  routeAgain: string[],
  input: EditRunInput,
  t0: number,
): Promise<EditRunResult> {
  void t0;
  const dir = base.candidate.dir;
  const say = (p: number, note: string) => input.runners.progress?.(p, note);
  let repair: EditRunResult["repair"] = { available: false, routeAgain };
  let t = Date.now();
  if (input.runners.repair && routeAgain.length) {
    say(0.55, "repair (route stage)");
    const r = await input.runners.repair({ candidateDir: dir, pcb: base.candidate.pcb, routeAgain, ledger });
    repair = { available: true, ...(r ? { note: r.note } : {}), routeAgain };
  } else if (input.runners.repair) repair = { available: true, routeAgain };
  base.phases["repair"] = Math.round((Date.now() - t) / 100) / 10;
  say(0.7, "A1-A9 proof");
  t = Date.now();
  const beforeRec = await readJson<Scored>(join(dir, "before-acceptance.json"));
  let run = await input.runners.accept(dir, env.pcbName);
  base.phases["proof"] = Math.round((Date.now() - t) / 100) / 10;
  let after = await readFile(base.candidate.pcb, "utf8");
  const source = await readFile(join(dir, "before", env.pcbName), "utf8");
  let d = diffBoards(source, after);
  let ch = churn(d, ledger);
  // churn guard (editbench): nets the plan did not touch get their original copper back if the whole board stays as good
  let guard: EditRunResult["guard"];
  if (ch.collateral_nets) {
    say(0.85, `churn guard: original copper back on ${ch.collateral_nets} untouched net(s), then score`);
    t = Date.now();
    const g = await churnGuard(dir, env.pcbName, source, after, Object.keys(ch.collateral_detail), run, input.runners);
    base.phases["guard"] = Math.round((Date.now() - t) / 100) / 10;
    guard = { nets: Object.keys(ch.collateral_detail).sort(), kept: g.kept, ...(g.why ? { why: g.why } : {}) };
    if (g.kept) {
      run = g.run;
      after = g.text;
      d = diffBoards(source, after);
      ch = churn(d, ledger);
    }
  }
  const j = judge(beforeRec, run.result);
  await writeJsonFile(join(dir, "diff.json"), { ...d, churn: ch, ...(guard ? { guard } : {}) });
  const proof = { ...j, id: run.entry.id, record: run.recordPath, comparison: view(run.baseline ?? run.previous), before: beforeRec.summary as Record<string, boolean>, after: run.result.summary as Record<string, boolean> };
  await writeJsonFile(join(dir, "proof.json"), proof);
  return { ...base, stage: "proof", verdict: j.verdict, stop: false, repair, proof, diff: d, churn: ch, ...(guard ? { guard } : {}) };
}

/**
 * The editbench churn guard: a copy of the candidate with the collateral nets' copper taken from the source board,
 * scored; kept only when it is no worse on A1 opens, A2 errors, A7 and A8 nets and passes at least as many checks.
 * When kept, its board and its acceptance record (with its index entry) move into the candidate.
 */
async function churnGuard(
  dir: string,
  pcbName: string,
  source: string,
  after: string,
  nets: string[],
  run: AcceptRun,
  runners: EditRunners,
): Promise<{ kept: false; why?: string } | { kept: true; text: string; run: AcceptRun; why?: undefined }> {
  const scratch = join(dirname(dir), `.${basename(dir)}.guard`);
  await rm(scratch, { recursive: true, force: true });
  try {
    await cp(dir, scratch, { recursive: true, filter: (src) => basename(src) !== ".lastmile" });
    const text = revertNets(source, after, nets);
    await writeFile(join(scratch, pcbName), text);
    const g = await runners.accept(scratch, pcbName);
    const a = figures(g.result), b = figures(run.result);
    const passes = (r: AcceptRun["result"]) => Object.values(r.summary).filter(Boolean).length;
    const worse = (["A1", "A2", "A7", "A8"] as const).filter((k) => a[k] > b[k]);
    if (worse.length || passes(g.result) < passes(run.result))
      return { kept: false, why: worse.length ? `worse on ${worse.map((k) => `${k} ${b[k]}->${a[k]}`).join(", ")}` : "fewer checks pass" };
    await writeFile(join(dir, pcbName), text);
    for (const f of [g.entry.file, g.entry.file.replace(/\.json$/, ".drc.json")]) await cp(join(scratch, f), join(dir, f)).catch(() => {});
    const index = await readJson<AcceptIndexEntry[]>(join(acceptDir(dir), "index.json")).catch(() => [] as AcceptIndexEntry[]);
    await writeJsonFile(join(acceptDir(dir), "index.json"), [...index, g.entry]);
    return { kept: true, text, run: { ...g, recordPath: join(dir, g.entry.file) } };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function proofOnly(input: EditRunInput, plan: EditPlan, env: EditEnv, base: { mode: EditMode; planId: string; agentCoordinates: number; phases: Record<string, number> }): Promise<EditRunResult> {
  const dir = input.candidate ?? (await newestCandidate(env.projectDir, plan.id));
  if (!dir || !(await exists(join(dir, "edit.json")))) throw new EditStop(`FAIL proof: no candidate for plan ${plan.id} (run mode apply first, or name the candidate folder)`);
  const ledger = await readJson<{ plan: EditPlan; impact: ImpactReport; applied: ApplyLog }>(join(dir, "edit.json"));
  const routeAgain = [...new Set([...(ledger.applied.moves?.cut_nets ?? []), ...(ledger.applied.landing?.cut_nets ?? []), ...(ledger.applied.pad_cut?.cut_nets ?? [])])].sort();
  const candidate = { dir, pcb: join(dir, env.pcbName), origin: join(dir, "origin.json") };
  const res = await finish({ ...base, impact: ledger.impact, impactLines: impactLines(ledger.impact), candidate, applied: ledger.applied }, env, plan, ledger, routeAgain, input, Date.now());
  return res;
}

export { revertNets };
