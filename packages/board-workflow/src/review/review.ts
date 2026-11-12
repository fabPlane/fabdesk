/**
 * Whole-board review bound to one design hash, with dispositions and a gate.
 *
 *   runReview      every check -> `.fabdesk/board/review/runs/<time>-<hash>/review.{json,md}`
 *   reviewStatus   current or stale; open findings
 *   reviewGate     0 pass | 1 no/stale review | 2 open findings | 3 check errors; open items lead with their proposal
 *   dispose        a finding's disposition (state, who, reason, third source)
 *   importExpert   an independent reviewer's findings into the current review
 *   fixProposals   every open finding's proposal; `apply` settles what intent/evidence decides
 *
 * Findings: must-fix | question | note. Notes never block. A question is closed by any disposition with a reason; a
 * must-fix only by fixing it (it disappears) or by an owner 'accept'. 'false-positive' needs a third source. A
 * disposition is keyed by finding id and carries to later runs; the report marks it as carried. The reviewer never
 * edits a design.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { REGISTRY } from "./checks";
import { ReviewCtx, reviewHash, reviewHome, type ReviewEnv, type ReviewProject } from "./context";
import { propose, coveringDecision } from "./proposals";
import { loadCurrent, readDispositions, readIntent, reviewedPcb, runsDir, setLatest, writeDispositions } from "./store";
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

export const GATE_PASS = 0, GATE_STALE = 1, GATE_OPEN = 2, GATE_ERROR = 3;

// ---------------------------------------------------------------- dispositions

/** The owner's intent decides how far the agent's judgement goes, not the tool. Default: accepting a must-fix is the owner's. */
export function agentMayAcceptMustFix(intent: Intent | null): boolean {
  const pref = intent?.preferences ?? {};
  const intentGiven = !!intent && Object.keys(intent).length > 0;
  const ask = (pref.ask_owner_for ?? (intentGiven ? [] : ["accepting a must-fix"])).join(" ").toLowerCase();
  const allow = (pref.workflow_decides ?? []).join(" ").toLowerCase();
  return allow.includes("must-fix") || !ask.includes("must-fix");
}

/** (open?, why) for one finding under its disposition. Every rule asks for evidence, not for a particular path. */
export function judge(finding: { severity: string }, disp: Disposition | null | undefined, intent: Intent | null = null): [boolean, string] {
  if (finding.severity === "note") return [false, "note"];
  if (!disp) return [true, "no disposition"];
  const st = disp.state;
  if (!disp.reason) return [true, "disposition has no reason"];
  if (st === "fix") return [true, "marked fix but still present"];
  if (st === "false-positive" && !disp.third_source) return [true, "false-positive needs a third source"];
  if (finding.severity === "must-fix" && st === "accept" && disp.by !== "owner") {
    if (!agentMayAcceptMustFix(intent)) return [true, "must-fix accepted by agent: the owner's intent asks to be asked"];
    if (!(disp.third_source || disp.evidence)) return [true, "must-fix accepted by agent needs evidence (third_source)"];
  }
  return [false, st];
}

export interface Row extends FindingRecord {
  open: boolean;
  why: string;
  disposition: Disposition | null;
  carried: boolean;
}

export interface Evaluation {
  rows: Row[];
  errors: CheckRecord[];
  open: Row[];
}

export function evaluate(review: ReviewRecord, disps: Dispositions, intent: Intent | null = null): Evaluation {
  const rows: Row[] = [];
  for (const f of review.findings) {
    let d: Disposition | null = disps[f.id] ?? null;
    const dec = !d ? coveringDecision(f, intent ?? {}) : null;
    if (dec) // the owner already decided this (intent file): settled, cited
      d = { state: "accept", by: "owner", reason: `intent decision ${dec.id}: ${dec.decision.slice(0, 160)}`, third_source: dec.source ?? "", hash: review.hash };
    const [isOpen, why] = judge(f, d, intent);
    rows.push({ ...f, open: isOpen, why, disposition: d, carried: !!(d?.hash && d.hash !== review.hash) });
  }
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
 * task (agent work the tools cannot do yet), owner. Candidates are read from `review/fixes/` where the edit stage that
 * builds them records its result (`combined.json` {ready, fixes}, `*-repaired/review-hash.json`).
 */
export async function classify(project: ReviewProject, open: Row[]): Promise<Classified> {
  const fixes = join(reviewHome(project.dir), "fixes");
  const comb = await readJsonOrNull<{ ready?: boolean; fixes?: string[] }>(join(fixes, "combined.json"));
  const inCand = new Set(comb?.ready ? (comb.fixes ?? []) : []);
  const failed = new Set<string>();
  for (const n of (await readdir(fixes).catch(() => [] as string[])).filter((x) => x.endsWith("-repaired"))) {
    const rec = await readJsonOrNull<{ cand?: [string, string, number] }>(join(fixes, n, "review-hash.json"));
    if (rec?.cand && rec.cand[2] !== 0) failed.add(rec.cand[0]);
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
  /** Checks other stages add (the silk check of the silk stage), run after the built-in ones and before `pack`. */
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
  const cur = await loadCurrent(project);
  if (!cur.review) return { state: cur.state, run: cur.run, findings: 0, open: 0, errors: 0, mustFix: 0 };
  const ev = evaluate(cur.review, await readDispositions(project.dir), await readIntent(project.dir));
  return { state: cur.state, run: cur.run, findings: cur.review.findings.length, open: ev.open.length, errors: ev.errors.length, mustFix: ev.open.filter((r) => r.severity === "must-fix").length };
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
}

/** Owner checks a review skipped for want of `trustCustom`: said in the gate output, never silent. */
function notRunOf(review: ReviewRecord): number {
  const n = Number(review.checks.find((c) => c.name === "custom")?.artifacts?.["not_run"] ?? 0);
  return Number.isFinite(n) ? n : 0;
}
const notRunLine = (n: number) => `NOTE: ${n} owner check(s) not run (trustCustom off): board_review {"action": "run", "trustCustom": true} runs them`;

const ownerLine = (r: Row) => `- NEEDS OWNER [${r.severity}] ${r.id}: ${r.proposal?.action ?? r.claim.slice(0, 160)}${r.proposal?.effect ? ` — ${r.proposal.effect}` : ""}`;

export async function reviewGate(project: ReviewProject): Promise<GateResult> {
  const cur = await loadCurrent(project);
  if (cur.state !== "current" || !cur.review)
    return { exit: GATE_STALE, state: cur.state === "no review" ? "none" : "stale", current: false, open: 0, mustFix: 0, errors: false, lines: [`REVIEW GATE: BLOCKED (${cur.state}). Run: board_review {"action": "run"}`] };
  const ev = evaluate(cur.review, await readDispositions(project.dir), await readIntent(project.dir));
  const notRun = notRunOf(cur.review);
  const nr = notRun ? { notRun } : {};
  const nrLines = notRun ? [notRunLine(notRun)] : [];
  if (ev.errors.length)
    return { ...nr, exit: GATE_ERROR, state: "errors", current: true, open: ev.open.length, mustFix: ev.open.filter((r) => r.severity === "must-fix").length, errors: true, lines: ["REVIEW GATE: BLOCKED (check errors)", ...ev.errors.map((c) => `- ${c.name}: ${c.detail}`), ...nrLines] };
  if (ev.open.length) {
    // solution first: what the workflow does, then what needs the owner
    const k = await classify(project, ev.open);
    const lines = [`REVIEW GATE: ${ev.open.length} open — ${k.auto.length} the workflow applies (\`board_review fix\`), ${k.candidate.length} fixed in a READY candidate (adopt it), ${k.task.length} agent tasks, ${k.owner.length} need the owner`];
    for (const r of k.owner) lines.push(ownerLine(r));
    for (const [tag, rows] of [["candidate", k.candidate], ["auto", k.auto], ["task", k.task]] as const)
      for (const r of rows) lines.push(`- ${tag} [${r.severity}] ${r.id}: ${(r.proposal?.action ?? "").slice(0, 160)}`);
    lines.push(...nrLines);
    const ids = (rs: Row[]) => rs.map((r) => r.id);
    return { ...nr, exit: GATE_OPEN, state: "open", current: true, open: ev.open.length, mustFix: ev.open.filter((r) => r.severity === "must-fix").length, errors: false, lines, classified: { auto: ids(k.auto), candidate: ids(k.candidate), task: ids(k.task), owner: ids(k.owner) } };
  }
  return { ...nr, exit: GATE_PASS, state: "pass", current: true, open: 0, mustFix: 0, errors: false, lines: [`REVIEW GATE: PASS (${project.name}, hash ${cur.review.hash.slice(0, 12)}, ${cur.review.findings.length} findings dispositioned)`, ...nrLines] };
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
  const d = await readDispositions(project.dir);
  for (const i of targets)
    d[i] = { state: input.state as Disposition["state"], by: input.by, reason: input.reason, third_source: input.third_source ?? "", date: new Date().toISOString(), hash: cur.review.hash, claim: ids.get(i)!.claim.slice(0, 200) };
  await writeDispositions(project.dir, d);
  if (cur.state === "current" && cur.run) await writeFile(join(cur.run, "review.md"), reportMd(cur.review, evaluate(cur.review, d, await readIntent(project.dir))));
  return { disposed: targets, lines: targets.map((i) => `${i}: ${input.state} by ${input.by}`) };
}

export interface ExpertFile {
  reviewer?: string;
  findings?: Array<{ severity?: string; ref?: string; pad?: string | number; net?: string; claim?: string; evidence?: string; suggest?: string }>;
}

/** Add an independent reviewer's findings to the current review (replacing an earlier import and the pending marker). */
export async function importExpert(project: ReviewProject, ex: ExpertFile, source?: string): Promise<{ imported: number; run: string }> {
  const cur = await loadCurrent(project);
  if (cur.state !== "current" || !cur.review || !cur.run) throw new Error(`review is ${cur.state}: run it first`);
  const review = cur.review;
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
  await writeFile(join(cur.run, "review.json"), JSON.stringify(review, null, 1) + "\n");
  await writeFile(join(cur.run, "review.md"), reportMd(review, evaluate(review, await readDispositions(project.dir), intent)));
  return { imported: n, run: cur.run };
}

// ---------------------------------------------------------------- fix

/**
 * What builds an edit candidate from a proposal's plan. The edit stage provides it; until it is wired, edit proposals are
 * listed as tasks with their plan and nothing is built.
 */
export interface EditCandidateBuilder {
  build(plan: EditPlan, finding: FindingRecord): Promise<{ id: string; dir?: string; ready: boolean; notes: string[] }>;
}

export interface FixResult {
  open: number;
  workflow: Array<{ id: string; action: string; kind: string }>;
  owner: Array<{ id: string; severity: string; action: string; effect: string }>;
  /** Findings settled by the workflow's own disposition (apply only). */
  settled: string[];
  /** Edit proposals: built as candidates when a builder is wired, else listed with their plan. */
  edits: Array<{ id: string; plan: EditPlan; candidate?: { id: string; dir?: string; ready: boolean; notes: string[] } }>;
  tasks: Array<{ id: string; steps: string[] }>;
  commands: Array<{ id: string; cmd: string }>;
  lines: string[];
}

export async function fixProposals(project: ReviewProject, opts: { apply?: boolean; builder?: EditCandidateBuilder } = {}): Promise<FixResult> {
  const cur = await loadCurrent(project);
  if (cur.state !== "current" || !cur.review || !cur.run) throw new Error(`review is ${cur.state}: run board_review first`);
  const review = cur.review;
  const intent = await readIntent(project.dir);
  const ev = evaluate(review, await readDispositions(project.dir), intent);
  const wf = ev.open.filter((r) => r.proposal?.by === "workflow");
  const ow = ev.open.filter((r) => r.proposal?.by !== "workflow");
  const res: FixResult = { open: ev.open.length, workflow: [], owner: [], settled: [], edits: [], tasks: [], commands: [], lines: [`${project.name}: ${ev.open.length} open: ${wf.length} for the workflow, ${ow.length} for the owner`] };
  const d = await readDispositions(project.dir);
  for (const r of wf) {
    const ap = r.proposal!.apply;
    res.workflow.push({ id: r.id, action: r.proposal!.action, kind: ap.kind });
    if (!opts.apply) {
      res.lines.push(`  workflow ${r.id}: ${r.proposal!.action.slice(0, 150)}`);
      continue;
    }
    if (ap.kind === "disposition") {
      d[r.id] = { state: ap.state, by: ap.as === "owner" ? "owner" : "agent", reason: ap.reason, third_source: ap.third_source ?? "", date: new Date().toISOString(), hash: review.hash, claim: r.claim.slice(0, 200), via: "board_review fix" };
      res.settled.push(r.id);
    } else if (ap.kind === "edit") {
      const entry: FixResult["edits"][number] = { id: r.id, plan: ap.plan };
      if (opts.builder) entry.candidate = await opts.builder.build(ap.plan, r);
      res.edits.push(entry);
    } else if (ap.kind === "command") res.commands.push({ id: r.id, cmd: ap.cmd });
    else res.tasks.push({ id: r.id, steps: ap.steps });
  }
  if (opts.apply) {
    await writeDispositions(project.dir, d);
    await writeFile(join(cur.run, "review.md"), reportMd(review, evaluate(review, d, intent)));
    res.lines.push(`  settled ${res.settled.length} with recorded reasons`);
    for (const e of res.edits)
      res.lines.push(e.candidate ? `  candidate for ${e.id}: ${e.candidate.notes.join("; ").slice(0, 200)} (${e.candidate.ready ? "READY" : "not ready"})` : `  edit proposal ${e.id}: no candidate built (the edit stage is not wired to the review yet); plan ${JSON.stringify(e.plan).slice(0, 200)}`);
    for (const t of res.tasks) res.lines.push(`  agent task ${t.id}: ${t.steps.join("; ").slice(0, 160)}`);
    for (const c of res.commands) res.lines.push(`  command ${c.id}: ${c.cmd}`);
  }
  for (const r of ow) {
    res.owner.push({ id: r.id, severity: r.severity, action: r.proposal?.action ?? "", effect: r.proposal?.effect ?? "" });
    res.lines.push(`  NEEDS OWNER ${r.id}: ${r.proposal?.action ?? ""}` + (r.proposal?.effect ? ` — ${r.proposal.effect}` : ""));
  }
  return res;
}
