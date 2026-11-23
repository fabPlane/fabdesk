/**
 * The review's escape replay (the toolkit's `pcb review bench`): every known escape (a defect that reached a build)
 * with an `expect` names a replay board and the finding that must appear on it; the review runs on each replay board
 * with that board's checks, and an escape is CAUGHT when a non-note finding on the expected ref (and pad, and rule)
 * shows up. The clean boards (corrected revisions) report their L1-L4 non-note findings: the noise a fix leaves.
 *
 * This measures the reviewer, so it is a dev harness (`scripts/bench.ts review`), not an agent tool. The escapes ship
 * (`data/review/escapes.json`), the replay board list too (`data/review/bench-boards.json`); the board folders (the
 * toolkit's review/bench/boards, 21 MB of other projects' boards) do not: the bench is pointed at them. Each board is
 * reviewed in a copy, never in place.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import benchBoards from "../../data/review/bench-boards.json";
import { ESCAPES } from "../review/data";
import { writeJsonFile } from "../files";
import { openReviewProject } from "../review/store";
import { runReview } from "../review/review";
import type { ReviewEnv } from "../review/context";
import type { FindingRecord } from "../review/types";

export interface ReplayBoard {
  name: string;
  dir: string;
  stem: string;
  note?: string;
  checks_only: string[];
}

export const REPLAY_BOARDS: Record<string, ReplayBoard> = benchBoards.boards;

export interface EscapeExpect {
  board: string;
  ref: string;
  pad?: string;
  rule?: string;
  known_miss?: boolean;
}
export interface EscapesFile {
  escapes: Array<{ id: string; expect?: EscapeExpect[] }>;
  clean_boards?: string[];
}

export interface BenchRow {
  escape: string;
  board: string;
  expect: EscapeExpect;
  caught: boolean;
  by: string[];
  expected_miss: boolean;
}

export interface BenchResult {
  date: string;
  caught: number;
  expected: number;
  rows: BenchRow[];
  clean: Array<{ board: string; findings_L1_L4: number; ids: string[] }>;
  lines: string[];
}

export interface ReviewBenchOptions {
  /** The folder holding the replay boards' folders (a387/, b2245/, ...). */
  boardsDir: string;
  /** Scratch folder: each board is copied to work/<name> and reviewed there. */
  work: string;
  /** The review environment for a board copy (kicad-cli, BOM decisions none, custom checks off). */
  env: (projectDir: string) => ReviewEnv;
  escapes?: EscapesFile;
  boards?: Record<string, ReplayBoard>;
  progress?: (note: string) => void;
}

/** A non-note finding on the expected ref (pad and rule when the escape names them). */
export function catches(f: Pick<FindingRecord, "severity" | "ref" | "pad" | "rule">, x: EscapeExpect): boolean {
  return f.severity !== "note" && f.ref === x.ref && (!x.pad || f.pad === x.pad) && (!x.rule || f.rule === x.rule);
}

async function reviewCopy(o: ReviewBenchOptions, cfgName: string): Promise<{ name: string; findings: FindingRecord[] }> {
  const b = (o.boards ?? REPLAY_BOARDS)[cfgName];
  if (!b) throw new Error(`no replay board ${cfgName} (data/review/bench-boards.json)`);
  const dir = join(o.work, b.name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const src = join(o.boardsDir, b.dir);
  for (const n of await readdir(src)) if (!n.startsWith(".")) await cp(join(src, n), join(dir, n), { recursive: true });
  await writeJsonFile(join(dir, ".fabdesk", "board", "review", "config.json"), { name: b.name, checks_only: b.checks_only });
  const project = await openReviewProject(dir, `${b.stem}.kicad_pcb`);
  o.progress?.(`== ${b.name}`);
  const res = await runReview(project, o.env(dir), { offline: true, progress: (n) => o.progress?.(`  ${n}`) });
  return { name: b.name, findings: res.review.findings };
}

/** Run the escape replay. */
export async function reviewBench(o: ReviewBenchOptions): Promise<BenchResult> {
  const esc = o.escapes ?? (ESCAPES as unknown as EscapesFile);
  const byBoard = new Map<string, Array<[{ id: string }, EscapeExpect]>>();
  for (const e of esc.escapes) for (const x of e.expect ?? []) (byBoard.get(x.board) ?? byBoard.set(x.board, []).get(x.board)!).push([e, x]);
  const rows: BenchRow[] = [];
  for (const cfg of [...byBoard.keys()].sort()) {
    const { name, findings } = await reviewCopy(o, cfg);
    for (const [e, x] of byBoard.get(cfg)!) {
      const hit = findings.filter((f) => catches(f, x));
      rows.push({ escape: e.id, board: name, expect: x, caught: hit.length > 0, by: hit.map((f) => f.id), expected_miss: !!x.known_miss });
    }
  }
  const clean: BenchResult["clean"] = [];
  for (const cfg of esc.clean_boards ?? []) {
    const { name, findings } = await reviewCopy(o, cfg);
    const n = findings.filter((f) => f.severity !== "note" && ["L1", "L2", "L3", "L4"].includes(f.layer));
    clean.push({ board: name, findings_L1_L4: n.length, ids: n.map((f) => f.id) });
  }
  const caught = rows.filter((r) => r.caught).length;
  const pyList = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;
  const lines = [
    `escape replay: ${caught}/${rows.length} caught`,
    ...rows.map((r) => `  ${r.escape} ${r.board.padEnd(10)} ${r.expect.ref}${r.expect.pad ? `.${r.expect.pad}` : ""} ${r.caught ? "CAUGHT" : "missed"}${r.expected_miss && !r.caught ? " (known miss)" : ""} ${pyList(r.by.slice(0, 2))}`),
    ...clean.map((n) => `  clean ${n.board}: ${n.findings_L1_L4} L1-L4 findings ${pyList(n.ids.slice(0, 4))}`),
  ];
  return { date: new Date().toISOString(), caught, expected: rows.length, rows, clean, lines };
}
