/**
 * The project's definition of done as `board_check` recorded it: the acceptance results (A1-A9) that
 * `board_check` keeps under `<project>/.fabdesk/board/accept/index.json`, matched to the saved board.
 * Pure file reads, so the project status, Finish it and the agent docs can all ask the same question.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentReviewHash } from "@fabdesk/board-workflow";
import { acceptSummary, type AcceptRecord } from "@fabdesk/protocol";

export type AcceptanceState = {
  /** none: never measured; stale: measured on an earlier board; current: measured on the saved board. */
  state: "none" | "stale" | "current";
  /** Checks that fail in the newest result (empty when all pass). Meaningful unless state is "none". */
  failing: string[];
  /** All of A1-A9 pass on the current board. */
  pass: boolean;
  /** Checks that already failed in the project's first result (the board as onboarded). */
  baselineFailing: string[];
  /** Failing now but not in the first result: what the work broke. */
  regressions: string[];
  at?: string;
};

type Entry = { at?: string; sha256?: string | null; summary?: Record<string, boolean> };

export async function readAcceptanceState(projectDir: string): Promise<AcceptanceState> {
  const index = JSON.parse((await readFile(join(projectDir, ".fabdesk", "board", "accept", "index.json"), "utf8").catch(() => "")) || "[]") as Entry[];
  if (!Array.isArray(index) || index.length === 0) return { state: "none", failing: [], pass: false, baselineFailing: [], regressions: [] };
  const board = await readFile(join(projectDir, "board.kicad_pcb")).catch(() => null);
  const sha = board ? createHash("sha256").update(board).digest("hex") : null;
  const hit = [...index].reverse().find((e) => e.sha256 && e.sha256 === sha);
  const entry = hit ?? index[index.length - 1]!;
  const failing = Object.entries(entry.summary ?? {}).filter(([, ok]) => !ok).map(([k]) => k);
  const baselineFailing = Object.entries(index[0]!.summary ?? {}).filter(([, ok]) => !ok).map(([k]) => k);
  const regressions = failing.filter((k) => !baselineFailing.includes(k));
  return { state: hit ? "current" : "stale", failing, pass: !!hit && failing.length === 0, baselineFailing, regressions, ...(entry.at ? { at: entry.at } : {}) };
}

/** The saved board already has placed parts (it is an existing board, not a blank): looks only at its first 4 MB. */
export async function projectHasPlacedBoard(projectDir: string): Promise<boolean> {
  const fh = await open(join(projectDir, "board.kicad_pcb"), "r").catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return /\(footprint\s/.test(buf.toString("utf8", 0, bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * How "done" is judged. A board that came in with failing checks (a real board never checked by board_check) is
 * judged "no new failure" against its first result; one built from scratch is judged strictly. Recorded when a
 * Finish it run starts, so it survives a restart.
 */
export type DoneMode = "strict" | "no-regression";
const modeFile = (dir: string) => join(dir, ".fabdesk", "board", "done-mode.json");

export async function readDoneMode(projectDir: string): Promise<DoneMode> {
  const d = JSON.parse((await readFile(modeFile(projectDir), "utf8").catch(() => "")) || "null") as { mode?: DoneMode } | null;
  return d?.mode === "no-regression" ? "no-regression" : "strict";
}

export async function writeDoneMode(projectDir: string, mode: DoneMode): Promise<void> {
  await mkdir(join(projectDir, ".fabdesk", "board"), { recursive: true });
  await writeFile(modeFile(projectDir), JSON.stringify({ mode, at: new Date().toISOString() }) + "\n");
}

/** A1-A9 count as passed: all pass, or (no-regression) nothing newly failing while some failure was already there. */
export function acceptanceSatisfied(a: AcceptanceState, mode: DoneMode): boolean {
  if (a.state !== "current") return false;
  if (a.pass) return true;
  return mode === "no-regression" && a.regressions.length === 0;
}

/**
 * Fixes the judging mode the first time a project is finished: a board that is already placed before board_check
 * has measured anything is "no-regression" (its failures are not ours); otherwise strict. Never changes a mode
 * once set, so a resumed run cannot forgive failures its own earlier work made.
 */
export async function initDoneMode(projectDir: string, boardAlreadyPlaced: boolean): Promise<DoneMode> {
  if (await readFile(modeFile(projectDir)).then(() => true, () => false)) return readDoneMode(projectDir);
  const mode: DoneMode = boardAlreadyPlaced && (await readAcceptanceState(projectDir)).state === "none" ? "no-regression" : "strict";
  await writeDoneMode(projectDir, mode);
  return mode;
}

/**
 * The project's review gate as the board tools last reported it. `board_review` records it (run, gate, dispose, fix,
 * import_expert) together with the review's one design hash (board, schematics, project and rule files, requirements,
 * `review.hash_extra`; `currentReviewHash`), so any change to what the review covered makes it stale here too: the
 * Status page, Finish it and `board_release fab` all read this. pass = the review is current and every finding is settled.
 */
export type ReviewGate = { state: "none" | "stale" | "open" | "errors" | "pass"; open?: number; mustFix?: number; at?: string };
const gateFile = (dir: string) => join(dir, ".fabdesk", "board", "review-gate.json");

const boardSha = async (dir: string) => {
  const b = await readFile(join(dir, "board.kicad_pcb")).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};
const reviewDesignHash = (dir: string) => currentReviewHash(dir).catch(() => null);

export async function recordReviewGate(projectDir: string, r: { current: boolean; open: number; mustFix: number; errors?: boolean }): Promise<void> {
  const state: ReviewGate["state"] = r.errors ? "errors" : !r.current ? "stale" : r.open > 0 ? "open" : "pass";
  await mkdir(join(projectDir, ".fabdesk", "board"), { recursive: true });
  await writeFile(gateFile(projectDir), JSON.stringify({ state, open: r.open, mustFix: r.mustFix, designHash: await reviewDesignHash(projectDir), at: new Date().toISOString() }) + "\n");
}

export async function readReviewGate(projectDir: string): Promise<ReviewGate> {
  const d = JSON.parse((await readFile(gateFile(projectDir), "utf8").catch(() => "")) || "null") as (ReviewGate & { designHash?: string | null }) | null;
  if (!d?.state) return { state: "none" };
  // a record without a design hash (older, board-only records) cannot prove the design is unchanged: stale
  const stale = !d.designHash || d.designHash !== (await reviewDesignHash(projectDir));
  return { state: stale ? "stale" : d.state, ...(d.open !== undefined ? { open: d.open } : {}), ...(d.mustFix !== undefined ? { mustFix: d.mustFix } : {}), ...(d.at ? { at: d.at } : {}) };
}

/**
 * Onboarding's guesses (net classes, pairs, anchors, planes) are the onboarding stage's first reading of a board; the review list
 * names what to confirm. `confirmed` is recorded with `board_check {"confirm": true}` (who, when, a note) after the
 * agent or owner checked them against the circuit, and goes stale when onboarding is derived again (onboard.json changes).
 */
export type OnboardingCheck = { toConfirm: string[]; decided: string[]; counts: Record<string, unknown>; confirmed: boolean; by?: OnboardingConfirmer; at?: string };
export type OnboardingConfirmer = "agent" | "owner";
/** Where `onboard` (board-workflow) writes its record, and the confirmation kept beside it (bound to that record's hash). */
const onboardFile = (dir: string) => join(dir, ".fabdesk", "board", "onboard.json");
const confirmFile = (dir: string) => join(dir, ".fabdesk", "board", "onboard-confirmed.json");
const shaOf = async (path: string) => {
  const b = await readFile(path).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};

export async function readOnboardingCheck(projectDir: string): Promise<OnboardingCheck | undefined> {
  const raw = JSON.parse((await readFile(onboardFile(projectDir), "utf8").catch(() => "")) || "null") as { review?: string[]; decided?: string[]; counts?: Record<string, unknown> } | null;
  if (!raw) return undefined;
  const mark = JSON.parse((await readFile(confirmFile(projectDir), "utf8").catch(() => "")) || "null") as { onboardSha256?: string; by?: OnboardingConfirmer; at?: string } | null;
  const confirmed = !!mark?.onboardSha256 && mark.onboardSha256 === (await shaOf(onboardFile(projectDir)));
  return { toConfirm: raw.review ?? [], decided: raw.decided ?? [], counts: raw.counts ?? {}, confirmed, ...(confirmed && mark?.by ? { by: mark.by } : {}), ...(confirmed && mark?.at ? { at: mark.at } : {}) };
}

/** Record that the current onboarding proposals were checked against the circuit (false when nothing was onboarded). */
export async function confirmOnboarding(projectDir: string, note?: string, by: OnboardingConfirmer = "agent"): Promise<boolean> {
  const sha = await shaOf(onboardFile(projectDir));
  if (!sha) return false;
  await writeFile(confirmFile(projectDir), JSON.stringify({ onboardSha256: sha, by, at: new Date().toISOString(), ...(note ? { note } : {}) }) + "\n");
  return true;
}

export type BoardOverview = {
  history: Array<{ at: string; failing: string[]; pass: boolean; current: boolean }>;
  candidates: Array<{ id: string; verdict: string; startedAt: string; seconds: number; collateralNets: number }>;
  review: ReviewGate;
  onboarding: { toConfirm: number; confirmed: boolean; by?: OnboardingConfirmer; at?: string } | null;
};

/** What the Status page shows beyond the current A1-A9 line: recent results, edit candidates, review gate, onboarding. */
export async function readBoardOverview(projectDir: string, limit = 8): Promise<BoardOverview> {
  const sha = await boardSha(projectDir);
  const index = JSON.parse((await readFile(join(projectDir, ".fabdesk", "board", "accept", "index.json"), "utf8").catch(() => "")) || "[]") as Entry[];
  const history = (Array.isArray(index) ? index : []).slice(-limit).reverse().map((e) => {
    const failing = Object.entries(e.summary ?? {}).filter(([, ok]) => !ok).map(([k]) => k);
    return { at: e.at ?? "", failing, pass: failing.length === 0, current: !!e.sha256 && e.sha256 === sha };
  });
  const editsDir = join(projectDir, ".fabdesk", "board", "edits");
  const names = await readdir(editsDir).catch(() => [] as string[]);
  const cands = await Promise.all(names.map(async (n) => {
    const r = JSON.parse((await readFile(join(editsDir, n, "result.json"), "utf8").catch(() => "")) || "null") as { id?: string; verdict?: string; started?: string; total_s?: number; churn?: { collateral_nets?: number } } | null;
    return r ? { id: r.id ?? n, verdict: String(r.verdict ?? "unknown"), startedAt: r.started ?? "", seconds: Math.round(r.total_s ?? 0), collateralNets: r.churn?.collateral_nets ?? 0 } : null;
  }));
  const candidates = cands.filter((c): c is NonNullable<typeof c> => !!c).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  const ob = await readOnboardingCheck(projectDir);
  return { history, candidates, review: await readReviewGate(projectDir), onboarding: ob ? { toConfirm: ob.toConfirm.length, confirmed: ob.confirmed, ...(ob.by ? { by: ob.by } : {}), ...(ob.at ? { at: ob.at } : {}) } : null };
}

/**
 * What the board workflow knows about the saved board, as advisory lines for `release_build` (never blocking: the hard
 * gate is `board_release`). Empty when the project has not used the board workflow.
 */
export async function releaseAdvisories(projectDir: string): Promise<string[]> {
  const used = await stat(join(projectDir, ".fabdesk", "board")).then(() => true, () => false);
  if (!used) return [];
  const [acc, mode, gate, ob] = await Promise.all([readAcceptanceState(projectDir), readDoneMode(projectDir), readReviewGate(projectDir), readOnboardingCheck(projectDir)]);
  const lines: string[] = [];
  if (acc.state === "none") lines.push("A1-A9 not measured on this board: board_check");
  else if (acc.state === "stale") lines.push("A1-A9 measured on an earlier board: board_check");
  else if (acc.pass) lines.push("A1-A9 pass");
  else if (mode === "no-regression" && acc.regressions.length === 0) lines.push(`A1-A9: no new failure; ${acc.failing.join(", ")} failed before the work`);
  else lines.push(`A1-A9 failing ${acc.failing.join(", ")}${acc.regressions.length ? ` (new: ${acc.regressions.join(", ")})` : ""}`);
  lines.push(gate.state === "pass" ? "Review gate passes" : gate.state === "none" ? "Review not run: board_review run" : gate.state === "stale" ? "Review is stale (the design changed since): board_review run" : gate.state === "errors" ? "Review has check errors" : `Review: ${gate.open ?? "?"} findings open (${gate.mustFix ?? 0} must-fix)`);
  if (ob && !ob.confirmed && ob.toConfirm.length) lines.push(`Onboarding: ${ob.toConfirm.length} derived requirements not yet confirmed against the circuit: check them, then board_check {"confirm": true}`);
  return lines;
}

/**
 * Append one acceptance record to `<project>/.fabdesk/board/accept/index.json` (what `board_check` calls after it
 * measures A1-A9 on the saved board). `sha256` is the saved board file's hash; readers match it to the board on disk.
 */
export async function recordAcceptance(projectDir: string, record: AcceptRecord): Promise<void> {
  const file = join(projectDir, ".fabdesk", "board", "accept", "index.json");
  const prior = JSON.parse((await readFile(file, "utf8").catch(() => "")) || "[]") as unknown[];
  const index = Array.isArray(prior) ? prior : [];
  index.push({ at: record.at, sha256: record.sha256, summary: acceptSummary(record.results), results: record.results });
  await mkdir(join(projectDir, ".fabdesk", "board", "accept"), { recursive: true });
  await writeFile(file, JSON.stringify(index) + "\n");
}
