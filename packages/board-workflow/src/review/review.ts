import { stageState, readIndependentReview } from "../stages";
/**
 * Whole-board review bound to one design hash, with dispositions and a gate.
 *
 *   runReview      every check -> `.fabdesk/board/review/runs/<time>-<hash>/review.{json,md}`
 *   reviewStatus   current or stale; open findings
 *   reviewGate     0 pass | 1 no/stale review | 2 open findings | 3 check errors; open items lead with their proposal
 *   dispose        a finding's disposition (state, who, reason, third source)
 *   importExpert   an independent reviewer's findings into the current review
 *   fixProposals   every open finding's proposal; `apply` settles what intent/evidence decides, builds and proves an edit
 *                  candidate per edit proposal, the combined candidate and a change picture per READY one (candidates.ts)
 *   (candidates.ts) tryPlan: the agent's own plan through the same proof; (autopilot.ts) review -> fixes -> owner only;
 *   (intent.ts)    the owner's intent file: init, decide, show
 *
 * Findings: must-fix | question | note. Notes never block. A question is closed by an owner disposition, or by an
 * agent 'accept' that cites a third source (or that the owner's intent delegates); a
 * must-fix only by fixing it (it disappears) or by an owner 'accept'. 'false-positive' needs a third source. A
 * disposition is keyed by finding id and carries to later runs; the report marks it as carried. The reviewer never
 * edits a design.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { REGISTRY } from "./checks";
import { ReviewCtx, reviewHash, reviewHome, type ReviewEnv, type ReviewProject } from "./context";
import { coveringDecision, propose } from "./proposals";
import { loadCurrent, readDispositions, readIntent, reviewedPcb, runsDir, setLatest, writeDispositions, type Current } from "./store";
import {
  STATES,
  findingId,
  makeFinding,
  newResult,
  type CheckRecord,
  type CheckResult,
  type Disposition,
  type Dispositions,
  type EditPlan,
  type FindingRecord,
  type Intent,
  type ReviewRecord,
} from "./types";
import { readJsonOrNull } from "../files";
import { changePicture, combinedCandidate, fixesDir, readCandidateRecord, writeCandidateRecord, type CombinedRecord } from "./candidates";

import { evaluateFinding, type Row } from "./evaluation";
export { judge, agentMayAcceptMustFix, agentMayAcceptQuestion, type Row } from "./evaluation";

export const GATE_PASS = 0, GATE_STALE = 1, GATE_OPEN = 2, GATE_ERROR = 3;

// ---------------------------------------------------------------- dispositions

export interface Evaluation {
  rows: Row[];
  errors: CheckRecord[];
  open: Row[];
}

export function evaluate(review: ReviewRecord, disps: Dispositions, intent: Intent | null = null): Evaluation {
  const rows = review.findings.map(f => evaluateFinding(f, disps, intent, review.hash));
  const errors = review.checks.filter((c) => c.status === "error");
  return { rows, errors, open: rows.filter((r) => r.open) };
}

// ---------------------------------------------------------------- classification

export interface Classified {
  auto: Row[];
  candidate: Row[];
  task: Row[];
  owner: Row[];
}

/**
 * Open items by who moves them: auto (the workflow applies), candidate (fixed in a READY candidate, awaiting adoption),
 * task (agent work the tools cannot do yet), owner. Candidates are read from `review/fixes/`, where `fixProposals`
 * records them (`combined.json` {ready, fixes, hash}, `<id>-repaired/review-hash.json` {hash, cand}); with `hash`, a
 * record of another design is ignored.
 */
export async function classify(project: ReviewProject, open: Row[], hash?: string): Promise<Classified> {
  const fixes = join(reviewHome(project.dir), "fixes");
  // a record of another design (given `hash`) says nothing about this one
  const mine = (h: string | undefined) => !hash || h === hash;
  const comb = await readJsonOrNull<{ ready?: boolean; fixes?: string[]; hash?: string }>(join(fixes, "combined.json"));
  const inCand = new Set(comb?.ready && mine(comb.hash) ? (comb.fixes ?? []) : []);
  const failed = new Set<string>();
  for (const n of (await readdir(fixes).catch(() => [] as string[])).filter((x) => x.endsWith("-repaired"))) {
    const rec = await readJsonOrNull<{ cand?: [string, string, number]; hash?: string }>(join(fixes, n, "review-hash.json"));
    if (rec?.cand && rec.cand[2] !== 0 && mine(rec.hash)) failed.add(rec.cand[0]);
  }
  const out: Classified = { auto: [], candidate: [], task: [], owner: [] };
  for (const r of open) {
    const pr = r.proposal;
    if (failed.has(r.id) && !inCand.has(r.id)) out.task.push(r);
    else if (inCand.has(r.id)) out.candidate.push(r);
    else if (pr?.by !== "workflow") out.owner.push(r);
    else if (pr.apply.kind === "disposition" || pr.apply.kind === "edit") out.auto.push(r);
    else out.task.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- report

/** One page: verdict, checks, then open items grouped by check (suggestion once per rule), settled items, notes. */
export function reportMd(review: ReviewRecord, ev: Evaluation): string {
  const { rows, open } = ev;
  const wf = open.filter((r) => r.proposal?.by === "workflow").length;
  const verdict = ev.errors.length ? "BLOCKED: check errors" : open.length ? `OPEN: ${open.length} to settle — ${wf} the workflow can do (\`board_review fix\`), ${open.length - wf} need the owner` : "PASS";
  const nmf = open.filter((r) => r.severity === "must-fix").length;
  const L: string[] = [
    `# Review ${review.board}: ${verdict}` + (nmf ? ` (${nmf} must-fix)` : ""),
    "",
    `Design \`${review.hash.slice(0, 16)}\` · ${review.finished} · ${review.kicad} · ${review.seconds.toFixed(0)} s · gate: \`board_review gate\``,
    "",
    "| Check | Layer | Status | s | open | settled | notes | Detail |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of review.checks) {
    const mine = rows.filter((r) => r.check === c.name);
    L.push(`| ${c.name} | ${c.layer} | ${c.status} | ${c.seconds.toFixed(1)} | ${mine.filter((r) => r.open).length} | ${mine.filter((r) => !r.open && r.severity !== "note").length} | ${mine.filter((r) => r.severity === "note").length} | ${c.detail.slice(0, 100)} |`);
  }
  if (ev.errors.length) L.push("", "## Check errors (the gate never passes these)", "", ...ev.errors.map((c) => `- ${c.name}: ${c.detail}`));
  if (open.length) {
    L.push("", "## To settle", "");
    for (const chk of review.checks.map((c) => c.name)) {
      const mine = open.filter((r) => r.check === chk).sort((a, b) => Number(a.severity !== "must-fix") - Number(b.severity !== "must-fix") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!mine.length) continue;
      L.push(`### ${chk} (${mine.length})`);
      const hinted = new Set<string>();
      for (const r of mine) {
        const tag = r.severity === "must-fix" ? "**MUST-FIX** " : "";
        const why = r.why === "no disposition" ? "" : ` _(${r.why})_`;
        L.push(`- ${tag}\`${r.id}\` ${r.claim}${why}`);
        const pr = r.proposal;
        if (pr && !hinted.has(`${r.rule}\u0000${pr.action}`)) {
          hinted.add(`${r.rule}\u0000${pr.action}`);
          L.push(`  - **proposed (${pr.by}):** ${pr.action}` + (pr.effect ? ` — ${pr.effect}` : ""));
        }
      }
      L.push("");
    }
  }
  const settled = rows.filter((r) => !r.open && r.severity !== "note");
  if (settled.length) {
    L.push("## Settled", "");
    for (const r of settled) {
      const d = r.disposition!;
      L.push(`- \`${r.id}\` ${d.state} by ${d.by}${r.carried ? " (carried)" : ""}: ${d.reason ?? ""}` + (d.third_source ? ` [third source: ${d.third_source}]` : ""));
    }
    L.push("");
  }
  const notes = rows.filter((r) => r.severity === "note");
  if (notes.length) L.push(`## Notes (${notes.length})`, "", ...notes.map((r) => `- ${r.claim}`));
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------- run

export interface RunOptions {
  /** Run only these checks (a partial run is not linked as the latest review). */
  checks?: string[];
  offline?: boolean;
  /** Checks a host adds, run after the built-in ones and before `pack`. */
  extraChecks?: Array<[string, (ctx: ReviewCtx) => Promise<CheckResult>]>;
  progress?: (note: string) => void;
  now?: () => Date;
}

export interface RunResult {
  review: ReviewRecord;
  evaluation: Evaluation;
  dir: string;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");

export async function runReview(project: ReviewProject, env: ReviewEnv, opts: RunOptions = {}): Promise<RunResult> {
  const independent = await readIndependentReview(project.dir);
  const t0 = Date.now();
  const started = (opts.now?.() ?? new Date()).toISOString();
  const { hash: h0, files } = await reviewHash(project);
  const out = join(runsDir(project.dir), `${stamp(opts.now?.() ?? new Date())}-${h0.slice(0, 8)}`);
  await mkdir(out, { recursive: true });
  const ctx = new ReviewCtx(project, out, !!opts.offline, env);
  ctx.hash = h0;
  ctx.files = files;
  await ctx.load();
  const want = opts.checks?.length ? new Set(opts.checks) : null;
  const only = new Set(project.cfg.checks_only ?? []), skip = new Set(project.cfg.checks_skip ?? []);
  const wants = (n: string) => (!only.size || only.has(n)) && !skip.has(n);
  const registry = [...REGISTRY.filter(([n]) => n !== "pack"), ...(opts.extraChecks ?? []), ...REGISTRY.filter(([n]) => n === "pack")];
  for (const [name, fn] of registry) {
    if (want ? !want.has(name) : !wants(name)) continue;
    const t = Date.now();
    let r: CheckResult;
    try {
      r = await fn(ctx);
    } catch (e) {
      // a check that crashes is an error, never a pass
      r = { ...newResult(name, "?"), status: "error", detail: `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : String(e)}` };
      await writeFile(join(out, `${name}.traceback.txt`), e instanceof Error ? (e.stack ?? String(e)) : String(e));
    }
    r.seconds = (Date.now() - t) / 1000;
    // findings so far carry their ids for the expert pack
    ctx.results.push(r);
    opts.progress?.(`${name} ${r.layer} ${r.status} ${r.seconds.toFixed(1)}s ${r.findings.length} findings ${r.detail.slice(0, 90)}`);
  }
  const { hash: h2 } = await reviewHash(project);
  const intent = await readIntent(project.dir);
  const info = { oracle_pins: ctx.oraclePins, comps: ctx.comps };
  const target = { dir: project.dir, hasRequirements: !!ctx.acceptance };
  const findings: FindingRecord[] = [];
  for (const r of ctx.results)
    for (const f of r.findings) {
      const rec: FindingRecord = { ...f, id: findingId(f), check: r.name, proposal: null };
      rec.proposal = propose(rec, target, intent, info, project.name);
      findings.push(rec);
    }
  const checks: CheckRecord[] = ctx.results.map((r) => ({ name: r.name, layer: r.layer, status: r.status, seconds: r.seconds, detail: r.detail, artifacts: r.artifacts }));
  if (independent?.hash === ctx.hash && independent.pcb === reviewedPcb(project)) {
    findings.push(...independent.findings);
    checks.push({ name: "expert", layer: "L8", status: "ok", seconds: 0, detail: "Carried independent review for this board and design", artifacts: {} });
  }
  const review: ReviewRecord = {
    schema: "REVIEW_V1",
    board: project.name,
    pcb: reviewedPcb(project),
    config: join(reviewHome(project.dir), "config.json"),
    hash: ctx.hash,
    files: ctx.files,
    kicad: env.kicadVersion,
    started,
    finished: new Date().toISOString(),
    seconds: (Date.now() - t0) / 1000,
    partial: !!want,
    checks,
    findings,
  };
  if (h2 !== ctx.hash) review.checks.push({ name: "hash-stable", layer: "L0", status: "error", seconds: 0, detail: `design changed during the review (${ctx.hash.slice(0, 8)} -> ${h2.slice(0, 8)})`, artifacts: {} });
  const dup = new Map<string, number>();
  for (const f of findings) dup.set(f.id, (dup.get(f.id) ?? 0) + 1);
  for (const [k, n] of dup) if (n > 1) review.checks.push({ name: "ids", layer: "L0", status: "error", seconds: 0, detail: `finding id ${k} occurs ${n} times`, artifacts: {} }); // ids must be unique for dispositions to mean anything
  await writeFile(join(out, "review.json"), JSON.stringify(review, null, 1) + "\n");
  const evaluation = evaluate(review, await readDispositions(project.dir), intent);
  await writeFile(join(out, "review.md"), reportMd(review, evaluation));
  if (!want) await setLatest(project.dir, basename(out));
  return { review, evaluation, dir: out };
}

// ---------------------------------------------------------------- commands

export interface StatusResult {
  state: string;
  run: string | null;
  findings: number;
  open: number;
  errors: number;
  mustFix: number;
}

export async function reviewStatus(project: ReviewProject): Promise<StatusResult> {
  const { cur, ev } = await loadGateEvaluation(project);
  if (!cur.review) return { state: cur.state, run: cur.run, findings: 0, open: 0, errors: 0, mustFix: 0 };
  const gate = await gateFromEvaluation(project, cur, ev);
  return { state: cur.state, run: cur.run, findings: ev.rows.length, open: gate.open, errors: ev.errors.length, mustFix: ev.open.filter((r) => r.severity === "must-fix").length };
}

export interface GateResult {
  /** 0 pass | 1 no/stale review | 2 open findings | 3 check errors. */
  exit: 0 | 1 | 2 | 3;
  state: "pass" | "none" | "stale" | "open" | "errors";
  current: boolean;
  open: number;
  mustFix: number;
  errors: boolean;
  /** The lines the CLI printed: open items lead with their proposal. */
  lines: string[];
  classified?: { auto: string[]; candidate: string[]; task: string[]; owner: string[] };
  /** The project's own (custom) checks the review did not run because they were not trusted. */
  notRun?: number;
  evidence?: { checks: Array<{ name: string; status: string }>; dispositions: Array<{ id: string; state: string; by: string; reason: string }>; independentReview: "completed" | "deferred" | "missing" };
}

/** Owner checks a review skipped for want of `trustCustom`: said in the gate output, never silent. */
function notRunOf(review: ReviewRecord): number {
  const n = Number(review.checks.find((c) => c.name === "custom")?.artifacts?.["not_run"] ?? 0);
  return Number.isFinite(n) ? n : 0;
}
const notRunLine = (n: number) => `NOTE: ${n} owner check(s) not run (trustCustom off): board_review {"action": "run", "trustCustom": true} runs them`;

const ownerLine = (r: Row) => `- NEEDS OWNER [${r.severity}] ${r.id}: ${r.proposal?.action ?? r.claim.slice(0, 160)}${r.proposal?.effect ? ` — ${r.proposal.effect}` : ""}`;

export async function reviewGate(project: ReviewProject): Promise<GateResult> {
  const { cur, ev } = await loadGateEvaluation(project);
  return gateFromEvaluation(project, cur, ev);
}

/** Status and gate evaluate the same authoritative findings, including recovered legacy imports. */
async function loadGateEvaluation(project: ReviewProject): Promise<{ cur: Current; ev: Evaluation }> {
  const cur = await loadCurrent(project);
  // Legacy ordinary runs may omit an imported review; use the authoritative current import.
  if (cur.state === "current" && cur.review) {
    const independent = await readIndependentReview(project.dir);
    if (independent?.hash === cur.review.hash && independent.pcb === reviewedPcb(project))
      cur.review = { ...cur.review, findings: [...cur.review.findings.filter(f => f.check !== "expert"), ...independent.findings] };
  }
  const ev = cur.review ? evaluate(cur.review, await readDispositions(project.dir), await readIntent(project.dir)) : { rows: [], errors: [], open: [] };
  return { cur, ev };
}

async function gateFromEvaluation(project: ReviewProject, cur: Current, ev: Evaluation): Promise<GateResult> {
  if (cur.state !== "current" || !cur.review)
    return { exit: GATE_STALE, state: cur.state === "no review" ? "none" : "stale", current: false, open: 0, mustFix: 0, errors: false, lines: [`REVIEW GATE: BLOCKED (${cur.state}). Run: board_review {"action": "run"}`] };
  const stages = await stageState(project.dir, project.pcb);
  const coverageMissing = stages.independent.state !== "current" && !stages.independent.settled;
  const coverageLine = `independent review ${stages.independent.state} (${stages.independent.changedSince.length} changes since). Import a current independent review, or settle the coverage question with a reason (agent or owner).`;

  const notRun = notRunOf(cur.review);
  // Keep coverage settlements when pack changed IDs or was skipped; disclose each identity only once.
  const coverageSettlements = stages.independent.state === "current" ? [] : stages.independent.settlements;
  const rows = [...new Map([...coverageSettlements, ...ev.rows].map(r => [r.id, r])).values()];
  const dispositions = rows.filter(r => r.disposition).map(r => ({ id: r.id, state: r.disposition!.state, by: r.disposition!.by, reason: r.disposition!.reason }));
  const independentReview = stages.independent.state === "current" ? "completed" as const : stages.independent.state === "deferred" ? "deferred" as const : "missing" as const;
  const evidence = { checks: cur.review.checks.map(c => ({ name: c.name, status: c.status })), dispositions, independentReview };
  const nr = { ...(notRun ? { notRun } : {}), evidence };
  const ignored = [...new Set([...stages.independent.ignoredDispositions, ...ev.open.map(r => r.why).filter(why => why.includes(" ignored:"))])];
  const nrLines = [...ignored, ...(coverageMissing ? [coverageLine] : []), ...(notRun ? [notRunLine(notRun)] : []), `Independent review: ${independentReview}.`, ...dispositions.map(d => `${d.id}: ${d.state} by ${d.by}: ${d.reason}`)];
  if (ev.errors.length)
    return { ...nr, exit: GATE_ERROR, state: "errors", current: true, open: ev.open.length, mustFix: ev.open.filter((r) => r.severity === "must-fix").length, errors: true, lines: ["REVIEW GATE: BLOCKED (check errors)", ...ev.errors.map((c) => `- ${c.name}: ${c.detail}`), ...nrLines] };
  if (ev.open.length) {
    // solution first: what the workflow does, then what needs the owner
    const k = await classify(project, ev.open, cur.review.hash);
    const lines = [`REVIEW GATE: ${ev.open.length} open — ${k.auto.length} the workflow applies (\`board_review fix\`), ${k.candidate.length} fixed in a READY candidate (adopt it), ${k.task.length} agent tasks, ${k.owner.length} need the owner`];
    for (const r of k.owner) lines.push(ownerLine(r));
    for (const [tag, rows] of [["candidate", k.candidate], ["auto", k.auto], ["task", k.task]] as const)
      for (const r of rows) lines.push(`- ${tag} [${r.severity}] ${r.id}: ${(r.proposal?.action ?? "").slice(0, 160)}`);
    lines.push(...nrLines);
    const ids = (rs: Row[]) => rs.map((r) => r.id);
    return { ...nr, exit: GATE_OPEN, state: "open", current: true, open: ev.open.length, mustFix: ev.open.filter((r) => r.severity === "must-fix").length, errors: false, lines, classified: { auto: ids(k.auto), candidate: ids(k.candidate), task: ids(k.task), owner: ids(k.owner) } };
  }
  if (coverageMissing) return { ...nr, exit: GATE_OPEN, state: "open", current: true, open: 1, mustFix: 0, errors: false, lines: ["REVIEW GATE: BLOCKED (independent coverage)", ...nrLines] };
  return { ...nr, exit: GATE_PASS, state: "pass", current: true, open: 0, mustFix: 0, errors: false, lines: [`REVIEW GATE: PASS (${project.name}, hash ${cur.review.hash.slice(0, 12)}, ${cur.review.findings.length} findings dispositioned; disposition gate only)`, ...nrLines] };
}

export interface DisposeInput {
  id: string;
  state: string;
  by: "agent" | "owner";
  reason: string;
  third_source?: string;
}

export async function dispose(project: ReviewProject, input: DisposeInput): Promise<{ disposed: string[]; lines: string[] }> {
  const cur = await loadCurrent(project);
  if (!cur.review) throw new Error("no review to dispose against");
  const ids = new Map(cur.review.findings.map((f) => [f.id, f]));
  const targets = [...ids.keys()].filter((i) => i === input.id || (input.id.endsWith("*") && i.startsWith(input.id.slice(0, -1))));
  if (!targets.length) throw new Error(`no finding ${input.id} in the latest review`);
  if (!(STATES as readonly string[]).includes(input.state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
  if (!input.reason.trim()) throw new Error("a recorded reason is required for a disposition");
  const d = await readDispositions(project.dir);
  for (const i of targets)
    d[i] = { state: input.state as Disposition["state"], by: input.by, reason: input.reason, third_source: input.third_source ?? "", date: new Date().toISOString(), hash: cur.review.hash, claim: ids.get(i)!.claim.slice(0, 200) };
  await writeDispositions(project.dir, d);
  if (cur.state === "current" && cur.run) await writeFile(join(cur.run, "review.md"), reportMd(cur.review, evaluate(cur.review, d, await readIntent(project.dir))));
  return { disposed: targets, lines: targets.map((i) => `${i}: ${input.state} by ${input.by}`) };
}

export interface ExpertFile {
  designHash?: string | null;
  pcb?: string;
  reviewer?: string;
  findings?: Array<{ severity?: string; ref?: string; pad?: string | number; net?: string; claim?: string; evidence?: string; suggest?: string }>;
}

/** Add an independent reviewer's findings to the current review (replacing an earlier import and the pending marker). */
export async function importExpert(project: ReviewProject, ex: ExpertFile, source?: string): Promise<{ imported: number; run: string }> {
  const cur = await loadCurrent(project);
  if (cur.state !== "current" || !cur.review || !cur.run) throw new Error(`review is ${cur.state}: run it first`);
  const review = cur.review;
  if (!ex.designHash || ex.designHash !== review.hash || ex.pcb !== reviewedPcb(project))
    throw new Error("expert provenance must name the current evidence pack's designHash and project-relative pcb");
  const sev: Record<string, "must-fix" | "question" | "note"> = { PROBLEM: "must-fix", QUESTION: "question", NOTE: "note" };
  review.findings = review.findings.filter((f) => !(f.layer === "L8" && (f.check === "pack" || f.check === "expert")));
  let n = 0;
  for (const [i, x] of (ex.findings ?? []).entries()) {
    let s = sev[String(x.severity ?? "").toUpperCase()] ?? "question";
    if (s === "must-fix" && !String(x.evidence ?? "").trim()) s = "question"; // a PROBLEM without evidence is a question
    const f = makeFinding({ layer: "L8", rule: "EXPERT", severity: s, claim: String(x.claim ?? "").slice(0, 300), ref: x.ref ?? "", pad: String(x.pad ?? ""), net: x.net ?? "", key: String(i).padStart(2, "0"), evidence: [{ source: ex.reviewer ?? "expert", detail: x.evidence ?? "" }], suggest: x.suggest ?? "" });
    review.findings.push({ ...f, id: findingId(f), check: "expert", proposal: null });
    n++;
  }
  const info = { oracle_pins: {}, comps: null };
  const intent = await readIntent(project.dir);
  for (const f of review.findings) if (f.check === "expert") f.proposal = propose(f, { dir: project.dir, hasRequirements: false }, intent, info, project.name);
  review.checks = [...review.checks.filter((c) => c.name !== "expert"), { name: "expert", layer: "L8", status: "ok", seconds: 0, detail: `${n} findings from ${ex.reviewer ?? "?"}`, artifacts: source ? { expert: resolve(source) } : {} }];
  await writeFile(join(reviewHome(project.dir), "independent.json"), JSON.stringify({ hash: ex.designHash, pcb: ex.pcb, files: review.files, at: new Date().toISOString(), findings: review.findings.filter(f => f.check === "expert") }, null, 1) + "\n");
  await writeFile(join(cur.run, "review.json"), JSON.stringify(review, null, 1) + "\n");
  await writeFile(join(cur.run, "review.md"), reportMd(review, evaluate(review, await readDispositions(project.dir), intent)));
  return { imported: n, run: cur.run };
}

// ---------------------------------------------------------------- fix

/** One edit candidate as the review sees it: built, proven and re-reviewed (READY), or why not. */
export interface Candidate {
  id: string;
  dir?: string;
  ready: boolean;
  notes: string[];
  /** The plan the candidate was built from (for a proposal: the ladder rung that built it). */
  plan?: EditPlan;
  verdict?: string;
  /** Targeted findings still in the candidate's review. */
  stillOpen?: string[];
  /** Must-fix or question findings the source's review did not have. */
  newFindings?: string[];
  collateralNets?: number;
  unplannedMoved?: number;
  proofPass?: boolean;
}

/**
 * What builds an edit candidate. The edit stage provides it (`createEditCandidateBuilder`); without one, edit proposals
 * are listed with their plan and nothing is built.
 */
export interface EditCandidateBuilder {
  /** A workflow proposal's plan, up the ladder of least disturbance, proven against the one finding it fixes. */
  build(plan: EditPlan, finding: FindingRecord): Promise<Candidate>;
  /** One plan as written (the agent's own, or the combined one), proven against every finding it targets. */
  prove(plan: EditPlan, findings: FindingRecord[]): Promise<Candidate>;
}

export interface FixResult {
  open: number;
  workflow: Array<{ id: string; action: string; kind: string }>;
  owner: Array<{ id: string; severity: string; action: string; effect: string }>;
  /** Findings settled by the workflow's own disposition (apply only). */
  settled: string[];
  /** Edit proposals: built as candidates when a builder is wired, else listed with their plan. */
  edits: Array<{ id: string; plan: EditPlan; candidate?: Candidate; reused?: boolean }>;
  /** Every READY edit applied together in one candidate and proven (two or more READY edits; apply only). */
  combined?: CombinedRecord;
  /** The change picture of every READY candidate (and of the combined one): `change.html` beside its board. */
  pictures: Array<{ id: string; page: string; summary: string }>;
  tasks: Array<{ id: string; steps: string[] }>;
  commands: Array<{ id: string; cmd: string }>;
  lines: string[];
}

export interface FixOptions {
  apply?: boolean;
  builder?: EditCandidateBuilder;
  /** False: settle only, build no candidate copies (the toolkit's --no-build, for a low disk). */
  build?: boolean;
  /** Leave out the agent-task and command lines (the autopilot prints its own summary). */
  quiet?: boolean;
}

export async function fixProposals(project: ReviewProject, opts: FixOptions = {}): Promise<FixResult> {
  const cur = await loadCurrent(project);
  if (cur.state !== "current" || !cur.review || !cur.run) throw new Error(`review is ${cur.state}: run board_review first`);
  const review = cur.review;
  const intent = await readIntent(project.dir);
  const ev = evaluate(review, await readDispositions(project.dir), intent);
  const wf = ev.open.filter((r) => r.proposal?.by === "workflow");
  const ow = ev.open.filter((r) => r.proposal?.by !== "workflow");
  const res: FixResult = { open: ev.open.length, workflow: [], owner: [], settled: [], edits: [], pictures: [], tasks: [], commands: [], lines: [`${project.name}: ${ev.open.length} open: ${wf.length} for the workflow, ${ow.length} for the owner`] };
  const d = await readDispositions(project.dir);
  const build = opts.build ?? true;
  for (const r of wf) {
    let ap = r.proposal!.apply;
    res.workflow.push({ id: r.id, action: r.proposal!.action, kind: ap.kind });
    if (!opts.apply) {
      res.lines.push(`  workflow ${r.id}: ${r.proposal!.action.slice(0, 150)}`);
      continue;
    }
    if (ap.kind === "disposition") {
      // Stored proposals can predate validation or a later edit to intent. Revalidate the raw decision on apply.
      const legacyDecision = /^owner decision (.*?) \(/.exec(ap.reason)?.[1];
      const decisionId = ap.intent_decision ?? legacyDecision;
      if (decisionId !== undefined) {
        const decision = coveringDecision(r, intent ?? {});
        if (!decision || decision.id !== decisionId) {
          res.lines.push(`  ${r.id}: intent decision ${decisionId} ignored: missing or invalid owner decision text/author`);
          continue;
        }
        const fresh = propose(r, { dir: project.dir, hasRequirements: false }, intent ?? {}, { oracle_pins: {}, comps: null });
        if (fresh?.apply.kind !== "disposition") continue;
        ap = fresh.apply;
      }
      d[r.id] = { state: ap.state, by: ap.as === "owner" ? "owner" : "agent", reason: ap.reason, third_source: ap.third_source ?? "", date: new Date().toISOString(), hash: review.hash, claim: r.claim.slice(0, 200), via: "board_review fix" };
      res.settled.push(r.id);
    } else if (ap.kind === "edit" && opts.builder && !build) res.tasks.push({ id: r.id, steps: ["candidate not built: disk low (free space, then fix again)"] });
    else if (ap.kind === "edit") {
      const entry: FixResult["edits"][number] = { id: r.id, plan: ap.plan };
      if (opts.builder) {
        // same design, same plan: the proven candidate is reused, not built again
        const prev = await readCandidateRecord(project.dir, r.id, review.hash, ap.plan);
        if (prev) {
          entry.candidate = prev;
          entry.reused = true;
        } else {
          entry.candidate = await opts.builder.build(ap.plan, r);
          await writeCandidateRecord(project.dir, r.id, review.hash, ap.plan, entry.candidate);
        }
      }
      res.edits.push(entry);
    } else if (ap.kind === "command") res.commands.push({ id: r.id, cmd: ap.cmd });
    else res.tasks.push({ id: r.id, steps: ap.steps });
  }
  if (opts.apply && opts.builder && build) {
    const ready = res.edits.filter((e) => e.candidate?.ready && e.candidate.dir);
    // one change per board: every READY edit in one plan, proven together
    if (ready.length > 1) res.combined = await combinedCandidate(project, review, ready.map((e) => ({ id: e.id, plan: e.candidate!.plan ?? e.plan })), opts.builder);
    // fewer than two READY edits now: an earlier combined record no longer stands for this set of fixes
    else await rm(join(fixesDir(project.dir), "combined.json"), { force: true });
  }
  if (opts.apply) {
    await writeDispositions(project.dir, d);
    await writeFile(join(cur.run, "review.md"), reportMd(review, evaluate(review, d, intent)));
    res.lines.push(`  settled ${res.settled.length} with recorded reasons`);
    for (const e of res.edits)
      res.lines.push(
        e.candidate
          ? `  candidate for ${e.id}: ${e.candidate.notes.join("; ").slice(0, 200)} (${e.candidate.ready ? "READY" : "not ready"})${e.reused ? " [reused: same design, same plan]" : ""}${e.candidate.dir ? `\n      ${e.candidate.dir}` : ""}`
          : `  edit proposal ${e.id}: no candidate built (no edit stage wired); plan ${JSON.stringify(e.plan).slice(0, 200)}`,
      );
    // every READY candidate comes with a picture of its change
    const pics: Array<{ id: string; dir: string }> = res.edits.filter((e) => e.candidate?.ready && e.candidate.dir).map((e) => ({ id: e.id, dir: e.candidate!.dir! }));
    if (res.combined?.ready) pics.push({ id: `combined (${res.combined.fixes.length} fixes)`, dir: res.combined.dir });
    for (const p of pics) {
      const pic = await changePicture(project, p.dir).catch(() => null);
      if (pic) res.pictures.push({ id: p.id, ...pic });
    }
    for (const p of res.pictures) res.lines.push(`  change picture ${p.id}: ${p.summary}\n      ${p.page}`);
    if (res.combined)
      res.lines.push(`  COMBINED candidate (${res.combined.fixes.length} fixes): ${res.combined.verdict}; still open ${res.combined.still_open.length ? res.combined.still_open.join(", ") : "none"}; collateral nets ${res.combined.collateral_nets ?? "?"}; ${res.combined.ready ? "READY for adoption" : "not ready"}\n      ${res.combined.dir}`);
    if (!opts.quiet) {
      for (const t of res.tasks) res.lines.push(`  agent task ${t.id}: ${t.steps.join("; ").slice(0, 160)}`);
      for (const c of res.commands) res.lines.push(`  command ${c.id}: ${c.cmd}`);
    }
  }
  for (const r of ow) {
    res.owner.push({ id: r.id, severity: r.severity, action: r.proposal?.action ?? "", effect: r.proposal?.effect ?? "" });
    res.lines.push(`  NEEDS OWNER ${r.id}: ${r.proposal?.action ?? ""}` + (r.proposal?.effect ? ` — ${r.proposal.effect}` : ""));
  }
  return res;
}
