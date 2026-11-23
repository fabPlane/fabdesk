/**
 * Edit candidates as the review keeps them (the toolkit's `review fix --apply` records and `review try`):
 *
 *   `review/fixes/<id>-repaired/review-hash.json`  {hash, plan, cand: [id, dir, 0 READY | 1 not, notes], candidate}
 *                                                  one per edit proposal; reused while the design and the plan are the same
 *   `review/fixes/combined.json`                   {dir, fixes, verdict, still_open, collateral_nets, ready, hash, plan}
 *                                                  every READY edit in one plan, proven together (one change per board)
 *   `review/tries/<plan>.plan.json|.result.json`   the agent's own plan through the same proof (`tryPlan`)
 *   `change.html` beside a READY candidate's board  the change picture (`review/diff.ts`)
 *
 * Candidates live where the edit stage puts them (`.fabdesk/board/edits/<plan>-<time>/`); the source is never touched.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { exists, readJsonOrNull, writeJsonFile } from "../files";
import { parseSexpr } from "../sexpr";
import { reviewHome, type ReviewProject } from "./context";
import { changePage, changeSummary, diffBoards } from "./diff";
import { boardParts } from "./geometry";
import type { Candidate, EditCandidateBuilder } from "./review";
import { loadCurrent } from "./store";
import type { EditPlan, FindingRecord, ReviewRecord } from "./types";

export const fixesDir = (dir: string) => join(reviewHome(dir), "fixes");
export const triesDir = (dir: string) => join(reviewHome(dir), "tries");
const safe = (id: string) => id.replace(/[^\w.-]+/g, "_");

/** Python's json.dumps(sort_keys=True), hashed: the same plan gives the same signature on both sides. */
function sorted(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sorted);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
  return x;
}
export const planSig = (plan: unknown): string => createHash("sha256").update(JSON.stringify(sorted(plan))).digest("hex").slice(0, 16);

interface CandidateRecord {
  hash: string;
  plan: string;
  cand: [string, string, number, string[]];
  candidate: Candidate;
}

const recordPath = (dir: string, id: string) => join(fixesDir(dir), `${safe(id)}-repaired`, "review-hash.json");

/** The candidate built for this finding's plan on this design, when it is still there. */
export async function readCandidateRecord(dir: string, id: string, hash: string, plan: EditPlan): Promise<Candidate | null> {
  const rec = await readJsonOrNull<CandidateRecord>(recordPath(dir, id));
  if (!rec || rec.hash !== hash || rec.plan !== planSig(plan) || !rec.candidate) return null;
  if (rec.candidate.dir && !(await exists(rec.candidate.dir))) return null;
  return rec.candidate;
}

export async function writeCandidateRecord(dir: string, id: string, hash: string, plan: EditPlan, c: Candidate): Promise<void> {
  const rec: CandidateRecord = { hash, plan: planSig(plan), cand: [id, c.dir ?? "", c.ready ? 0 : 1, c.notes], candidate: c };
  await writeJsonFile(recordPath(dir, id), rec);
}

/**
 * Every READY edit in one plan (the toolkit's merge): the first plan's fields, every move, every add renamed so its
 * reference is unique across the board and the merged plan, and the widest displacement any plan asked for.
 */
export function combinePlans(name: string, parts: Array<{ id: string; plan: EditPlan }>, taken: Iterable<string>): EditPlan {
  const plans = parts.map((p) => p.plan);
  const first = plans[0]!;
  const plan: EditPlan = { ...JSON.parse(JSON.stringify(first)), id: safe(`fix-combined-${name}`), reason: `combined READY review fixes: ${parts.map((p) => p.id).join(", ")}` };
  const moves = plans.flatMap((p) => p.move ?? []);
  if (moves.length) plan.move = JSON.parse(JSON.stringify(moves));
  else delete plan.move;
  const used = new Set(taken);
  const adds: NonNullable<EditPlan["add"]> = [];
  for (const p of plans)
    for (const a0 of p.add ?? []) {
      const a = JSON.parse(JSON.stringify(a0)) as typeof a0;
      const m = /^(.*?)(\d+)$/.exec(a.ref);
      const pre = m ? m[1]! : a.ref;
      let n = m ? Number(m[2]) : 900;
      while (used.has(`${pre}${n}`)) n++;
      a.ref = `${pre}${n}`;
      used.add(a.ref);
      adds.push(a);
    }
  if (adds.length) plan.add = adds;
  else delete plan.add;
  const disp = plans.map((p) => p.displace).filter((x): x is NonNullable<EditPlan["displace"]> => !!x);
  if (disp.length) plan.displace = disp.reduce((a, b) => ((b.radius ?? 0) > (a.radius ?? 0) ? b : a));
  else delete plan.displace;
  return plan;
}

export interface CombinedRecord {
  dir: string;
  fixes: string[];
  verdict: string;
  still_open: string[];
  collateral_nets: number | null;
  ready: boolean;
  hash: string;
  plan: string;
  notes?: string[];
}

/** The combined candidate: built and proven once per design and set of READY fixes; `combined.json` records it. */
export async function combinedCandidate(project: ReviewProject, review: ReviewRecord, ready: Array<{ id: string; plan: EditPlan }>, builder: EditCandidateBuilder): Promise<CombinedRecord> {
  // added parts get unique names across the merged plan and the board as reviewed
  const taken = boardParts(parseSexpr(await readFile(project.pcb, "utf8"))).map((p) => p.ref);
  const plan = combinePlans(project.name, ready, taken);
  const sig = planSig(plan);
  const fixes = ready.map((r) => r.id);
  const path = join(fixesDir(project.dir), "combined.json");
  const prev = await readJsonOrNull<CombinedRecord>(path);
  if (prev && prev.hash === review.hash && prev.plan === sig && JSON.stringify(prev.fixes) === JSON.stringify(fixes) && (!prev.dir || (await exists(prev.dir)))) return prev;
  await writeJsonFile(join(fixesDir(project.dir), "combined", "plan.json"), plan);
  const findings = fixes.map((i) => review.findings.find((f) => f.id === i)).filter((f): f is FindingRecord => !!f);
  const c = await builder.prove(plan, findings);
  const rec: CombinedRecord = {
    dir: c.dir ?? "",
    fixes,
    verdict: c.verdict ?? c.notes[0] ?? "",
    still_open: [...(c.stillOpen ?? []), ...(c.newFindings ?? []).map((n) => `NEW ${n}`)],
    collateral_nets: c.collateralNets ?? null,
    ready: c.ready,
    hash: review.hash,
    plan: sig,
    notes: c.notes,
  };
  await writeJsonFile(path, rec);
  return rec;
}

/** The change picture of a candidate against the source board: `change.html` in the candidate folder. */
export async function changePicture(project: ReviewProject, candidateDir: string): Promise<{ page: string; summary: string }> {
  const named = join(candidateDir, basename(project.pcb));
  const d = await diffBoards(project.pcb, (await exists(named)) ? named : candidateDir);
  const page = join(candidateDir, "change.html");
  await writeFile(page, changePage(d));
  return { page, summary: changeSummary(d) };
}

export interface TryResult {
  plan: string;
  fixes: string[];
  candidate: Candidate;
  ready: boolean;
  /** The change picture, when the candidate is READY. */
  picture?: { page: string; summary: string };
  record: string;
  lines: string[];
}

/**
 * The agent's own edit plan, proven exactly like the workflow's proposals (the toolkit's `review try`): the edit
 * pipeline (apply, repair, A1-A9, collateral), then a review of the candidate. READY = the proof passes, every finding
 * in `ids` is gone, no new must-fix or question, 0 collateral nets, 0 unplanned moves, no check error.
 */
export async function tryPlan(project: ReviewProject, input: { plan: EditPlan; ids?: string[] }, builder: EditCandidateBuilder): Promise<TryResult> {
  const cur = await loadCurrent(project);
  if (cur.state !== "current" || !cur.review) throw new Error(`review is ${cur.state}: run board_review {"action": "run"} first`);
  const ids = (input.ids ?? []).filter(Boolean);
  const known = new Map(cur.review.findings.map((f) => [f.id, f]));
  const unknown = ids.filter((i) => !known.has(i));
  if (unknown.length) throw new Error(`not in the current review: ${unknown.join(", ")}`);
  if (typeof input.plan?.id !== "string" || !/^[\w.-]+$/.test(input.plan.id)) throw new Error("plan.id is required (letters, digits, - _ .)");
  const plan: EditPlan = { ...input.plan };
  await writeJsonFile(join(triesDir(project.dir), `${plan.id}.plan.json`), plan);
  const candidate = await builder.prove(plan, ids.map((i) => known.get(i)!));
  const picture = candidate.ready && candidate.dir ? await changePicture(project, candidate.dir).catch(() => null) : null;
  const record = join(triesDir(project.dir), `${plan.id}.result.json`);
  const res: TryResult = { plan: plan.id, fixes: ids, candidate, ready: candidate.ready, ...(picture ? { picture } : {}), record, lines: [] };
  await writeJsonFile(record, { ...res, hash: cur.review.hash, lines: undefined });
  res.lines = [
    `${plan.id}: ${candidate.verdict ?? candidate.notes[0] ?? ""}; targeted ${ids.length ? ids.join(", ") : "none"}; still open ${candidate.stillOpen?.length ? candidate.stillOpen.join(", ") : "none"}; collateral nets ${candidate.collateralNets ?? "?"}; ${candidate.ready ? "READY" : "not ready"}`,
    ...candidate.notes.map((n) => `  ${n}`),
    ...(candidate.dir ? [`  candidate ${candidate.dir}`] : []),
    ...(picture ? [`  change picture: ${picture.summary}\n      ${picture.page}`] : []),
    candidate.ready ? `  READY for adoption: board_edit {"plan": <this plan>, "mode": "proof", "candidate": "${candidate.dir}", "adopt": true}` : "  not ready: read the notes, change the plan and try again",
  ];
  return res;
}
