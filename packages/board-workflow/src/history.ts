/**
 * Acceptance records: every A1-A9 result is kept under `.fabdesk/board/accept/`, keyed by the
 * design hash, and compared with the board as onboarded (the baseline) and with the previous result.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { checkAcceptance, CHECK_KEYS, CHECK_NAMES, figures, toAcceptResults, type AcceptCode, type AcceptResult, type AcceptanceResult, type CheckCode, type CheckKey, type DrcInput } from "./accept";
import { legacyNetRefs, parseBoard } from "./board";
import { boardHome, designHash, locateProject, readJsonOrNull, writeJsonFile } from "./files";
import { readOnboardRecord, readRequirements, type OnboardRecord } from "./onboard";
import type { Requirements } from "./requirements";

export interface AcceptIndexEntry {
  id: string;
  at: string;
  /** Board, schematics and project settings when the check ran. */
  boardHash: string;
  /** `boardHash` plus the requirements. */
  designHash: string;
  /** The board file's sha256: what `readAcceptanceState` in the tools package matches to the saved board. */
  sha256: string;
  /** Keyed by code ("A1".."A9"), as the board state readers expect. */
  summary: Record<AcceptCode, boolean>;
  figures: Record<AcceptCode, number>;
  /** The same verdicts in the protocol's `AcceptResult` shape. */
  results: AcceptResult[];
  /** False when schematic parity was skipped for this run. */
  parityChecked: boolean;
  /** Result file, relative to the project. */
  file: string;
}

export type Change = "same" | "fixed" | "regressed" | "improved" | "worse";

export interface CheckDelta {
  code: AcceptCode;
  key: CheckKey;
  name: string;
  before: { pass: boolean; figure: number };
  now: { pass: boolean; figure: number };
  change: Change;
}

export interface Comparison {
  against: "baseline" | "previous";
  /** The result compared with. */
  record: AcceptIndexEntry;
  deltas: CheckDelta[];
  /** Checks failing now that passed before. */
  newFailures: AcceptCode[];
  /** DRC error types whose count changed: rule -> [before, now]. */
  drcChange: Record<string, [number, number]>;
}

export function acceptDir(projectDir: string): string {
  return join(boardHome(projectDir), "accept");
}

export async function readIndex(projectDir: string): Promise<AcceptIndexEntry[]> {
  const idx = await readJsonOrNull<AcceptIndexEntry[]>(join(acceptDir(projectDir), "index.json"));
  return Array.isArray(idx) ? idx : [];
}

export function compare(
  against: Comparison["against"],
  before: { entry: AcceptIndexEntry; result?: AcceptanceResult | null },
  now: { summary: Record<AcceptCode, boolean>; figures: Record<AcceptCode, number>; result: AcceptanceResult },
): Comparison {
  const deltas = CHECK_KEYS.map((key): CheckDelta => {
    const code = key.slice(0, 2) as AcceptCode;
    const b = { pass: before.entry.summary[code] ?? true, figure: before.entry.figures[code] ?? 0 };
    const n = { pass: now.summary[code], figure: now.figures[code] };
    const change: Change =
      b.pass && !n.pass ? "regressed" : !b.pass && n.pass ? "fixed" : n.pass ? "same" : n.figure < b.figure ? "improved" : n.figure > b.figure ? "worse" : "same";
    return { code, key, name: CHECK_NAMES[code as CheckCode], before: b, now: n, change };
  });
  const drcChange: Record<string, [number, number]> = {};
  const was = (before.result?.results.A2_drc["errors"] ?? {}) as Record<string, number>;
  const is = (now.result.results.A2_drc["errors"] ?? {}) as Record<string, number>;
  for (const rule of new Set([...Object.keys(was), ...Object.keys(is)]))
    if ((was[rule] ?? 0) !== (is[rule] ?? 0)) drcChange[rule] = [was[rule] ?? 0, is[rule] ?? 0];
  return {
    against,
    record: before.entry,
    deltas,
    newFailures: deltas.filter((d) => d.change === "regressed").map((d) => d.code),
    drcChange,
  };
}

/** The result for the board as onboarded: the first run on the onboarded board hash, else the first run. */
export function pickBaseline(index: readonly AcceptIndexEntry[], onboarded: Pick<OnboardRecord, "boardHash"> | null): AcceptIndexEntry | null {
  if (onboarded) {
    const hit = index.find((e) => e.boardHash === onboarded.boardHash);
    if (hit) return hit;
  }
  return index[0] ?? null;
}

export type DrcProvider = (opts: { board: string; parity: boolean; outFile: string }) => Promise<DrcInput>;

export interface AcceptRun {
  entry: AcceptIndexEntry;
  result: AcceptanceResult;
  /** Against the board as onboarded; null when this run is that baseline. */
  baseline: Comparison | null;
  /** Against the run before this one; null for the first run. */
  previous: Comparison | null;
  /** True when the design files changed while the check ran (the result is for an older state). */
  changedDuringRun: boolean;
  recordPath: string;
}

async function loadResult(projectDir: string, e: AcceptIndexEntry): Promise<AcceptanceResult | null> {
  return readJsonOrNull<AcceptanceResult>(join(projectDir, e.file));
}

/**
 * Run A1-A9 on the project's board and keep the result. Requires onboarded requirements
 * (call `onboard` first). `drc` runs KiCad DRC with refilled zones and schematic parity.
 */
export async function runAcceptance(
  projectDir: string,
  opts: { drc: DrcProvider; parity?: boolean; pcb?: string; requirements?: Requirements; now?: () => Date },
): Promise<AcceptRun> {
  const files = await locateProject(projectDir, opts.pcb);
  const req = opts.requirements ?? (await readRequirements(projectDir));
  if (!req) throw new Error("no requirements: onboard the board first (.fabdesk/board/requirements is missing)");
  const text = await readFile(files.pcb, "utf8");
  const legacy = legacyNetRefs(text);
  if (legacy)
    throw new Error(
      `${files.pcb} is in the pre-10 KiCad file format (tracks name nets by number); every copper-based check would pass on nothing. Upgrade a copy with kicad-cli pcb upgrade.`,
    );
  const parity = opts.parity !== false;
  const before = await designHash(projectDir);
  const at = (opts.now?.() ?? new Date()).toISOString();
  const id = `${at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${before.design.slice(0, 8)}`;
  const dir = acceptDir(projectDir);
  const drcFile = join(dir, `${id}.drc.json`);
  await mkdir(dir, { recursive: true });
  const drc = await opts.drc({ board: files.pcb, parity, outFile: drcFile });
  const result = checkAcceptance(parseBoard(text), req, drc, { parityChecked: parity, boardPath: files.pcb });
  const after = await designHash(projectDir);
  const sums = Object.fromEntries(CHECK_KEYS.map((k) => [k.slice(0, 2), result.summary[k]])) as Record<AcceptCode, boolean>;
  const figs = figures(result);
  const entry: AcceptIndexEntry = {
    id,
    at,
    boardHash: before.board,
    designHash: before.design,
    sha256: createHash("sha256").update(text).digest("hex"),
    summary: sums,
    figures: figs,
    results: toAcceptResults(result),
    parityChecked: parity,
    file: `.fabdesk/board/accept/${id}.json`,
  };
  const recordPath = join(projectDir, entry.file);
  await writeJsonFile(recordPath, { ...result, designHash: before.design, boardHash: before.board, at });
  const index = await readIndex(projectDir);
  const now = { summary: sums, figures: figs, result };
  const onboarded = await readOnboardRecord(projectDir);
  const baseEntry = pickBaseline(index, onboarded);
  const prevEntry = index[index.length - 1] ?? null;
  const baseline = baseEntry ? compare("baseline", { entry: baseEntry, result: await loadResult(projectDir, baseEntry) }, now) : null;
  const previous =
    prevEntry && prevEntry !== baseEntry ? compare("previous", { entry: prevEntry, result: await loadResult(projectDir, prevEntry) }, now) : null;
  await writeJsonFile(join(dir, "index.json"), [...index, entry]);
  return { entry, result, baseline, previous, changedDuringRun: before.design !== after.design, recordPath };
}

export interface AcceptanceState {
  state: "none" | "current" | "stale";
  failing: AcceptCode[];
  pass: boolean;
  /** Checks that failed in the baseline run. */
  baselineFailing: AcceptCode[];
  /** Failing now and passing in the baseline. */
  regressions: AcceptCode[];
  at?: string;
}

/** The latest recorded result, matched to the saved design by its hash. */
export async function readAcceptanceState(projectDir: string): Promise<AcceptanceState> {
  const index = await readIndex(projectDir);
  const last = index[index.length - 1];
  if (!last) return { state: "none", failing: [], pass: false, baselineFailing: [], regressions: [] };
  const now = await designHash(projectDir);
  const current = now.design === last.designHash;
  const base = pickBaseline(index, await readOnboardRecord(projectDir)) ?? index[0]!;
  const codes = CHECK_KEYS.map((k) => k.slice(0, 2) as AcceptCode);
  const failing = codes.filter((k) => !last.summary[k]);
  const baselineFailing = codes.filter((k) => !base.summary[k]);
  return {
    state: current ? "current" : "stale",
    failing,
    pass: current && failing.length === 0,
    baselineFailing,
    regressions: failing.filter((k) => !baselineFailing.includes(k)),
    at: last.at,
  };
}

