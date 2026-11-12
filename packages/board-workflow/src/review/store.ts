/** Where the review keeps its records: `<project>/.fabdesk/board/review/`. */
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { locateProject, readJsonOrNull, writeJsonFile } from "../files";
import { reviewHome, reviewHash, type ReviewProject } from "./context";
import type { Dispositions, Intent, ReviewConfig, ReviewRecord } from "./types";

export const runsDir = (dir: string) => join(reviewHome(dir), "runs");
export const dispositionsPath = (dir: string) => join(reviewHome(dir), "dispositions.json");
export const intentPath = (dir: string) => join(reviewHome(dir), "intent.json");
export const configPath = (dir: string) => join(reviewHome(dir), "config.json");
const latestPath = (dir: string) => join(reviewHome(dir), "latest.json");

/** The project a review covers: its board, schematic and review settings. */
export async function openReviewProject(dir: string, pcb?: string): Promise<ReviewProject> {
  const files = await locateProject(dir, pcb);
  const cfg = (await readJsonOrNull<ReviewConfig & { name?: string }>(configPath(dir))) ?? {};
  return { dir, stem: files.stem, name: cfg.name ?? basename(dir), pcb: files.pcb, sch: join(files.dir, `${files.stem}.kicad_sch`), cfg, files };
}

/**
 * The design hash a review of `dir` is bound to now: `reviewHash` with the project's review settings (board,
 * schematics, project and rule files, requirements, `hash_extra`). Needs no board file, so a status reader can ask.
 */
export async function currentReviewHash(dir: string): Promise<string> {
  const cfg = (await readJsonOrNull<ReviewConfig>(configPath(dir))) ?? {};
  return (await reviewHash({ dir, cfg })).hash;
}

export const readDispositions = async (dir: string): Promise<Dispositions> => (await readJsonOrNull<Dispositions>(dispositionsPath(dir))) ?? {};
export const writeDispositions = (dir: string, d: Dispositions) => writeJsonFile(dispositionsPath(dir), Object.fromEntries(Object.entries(d).sort(([a], [b]) => (a < b ? -1 : 1))));
export const readIntent = async (dir: string): Promise<Intent> => (await readJsonOrNull<Intent>(intentPath(dir))) ?? {};

export async function setLatest(dir: string, run: string): Promise<void> {
  await writeJsonFile(latestPath(dir), { run });
}

export interface Current {
  review: ReviewRecord | null;
  /** Absolute path of the run folder. */
  run: string | null;
  state: "current" | "no review" | string;
}

/** The latest full review and whether it covers the design as it is now. */
export async function loadCurrent(project: ReviewProject): Promise<Current> {
  const l = await readJsonOrNull<{ run: string }>(latestPath(project.dir));
  const run = l ? join(runsDir(project.dir), l.run) : null;
  const review = run ? await readJsonOrNull<ReviewRecord>(join(run, "review.json")) : null;
  if (!run || !review) return { review: null, run: null, state: "no review" };
  const { hash } = await reviewHash(project);
  if (hash !== review.hash) return { review, run, state: `stale: design ${hash.slice(0, 8)} != reviewed ${review.hash.slice(0, 8)}` };
  const pcb = reviewedPcb(project);
  if (review.pcb !== pcb) return { review, run, state: review.pcb ? `stale: reviewed board ${review.pcb}, not ${pcb}` : `stale: the review does not name its board (run it again for ${pcb})` };
  return { review, run, state: "current" };
}

/** The board a review project covers, project-relative with "/" (what a review record's `pcb` names). */
export const reviewedPcb = (project: Pick<ReviewProject, "dir" | "pcb">): string => relative(project.dir, project.pcb).split(sep).join("/");

/** The latest full review's run folder name, when its record is still there. */
export async function latestRunName(dir: string): Promise<string | null> {
  const l = await readJsonOrNull<{ run?: string }>(latestPath(dir));
  if (!l?.run) return null;
  return (await readJsonOrNull<ReviewRecord>(join(runsDir(dir), l.run, "review.json"))) ? l.run : null;
}

/**
 * Everything a review gate result was computed from: the design hash, the dispositions, the owner's intent, the latest
 * run (its record's hash, so an imported expert or a rewritten record counts) and the board it covered. A saved gate
 * is only as good as this: any difference means it must be computed again.
 */
export interface ReviewBasis {
  design: string | null;
  dispositions: string | null;
  intent: string | null;
  run: string | null;
  pcb: string | null;
}

const fileSha = async (path: string): Promise<string | null> => {
  const b = await readFile(path).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};

export async function reviewBasis(dir: string): Promise<ReviewBasis> {
  const run = await latestRunName(dir);
  const rec = run ? await readJsonOrNull<ReviewRecord>(join(runsDir(dir), run, "review.json")) : null;
  const [design, dispositions, intent, runSha] = await Promise.all([
    currentReviewHash(dir).catch(() => null),
    fileSha(dispositionsPath(dir)),
    fileSha(intentPath(dir)),
    run ? fileSha(join(runsDir(dir), run, "review.json")) : Promise.resolve(null),
  ]);
  return { design, dispositions, intent, run: run ? `${run}#${runSha}` : null, pcb: rec?.pcb ?? null };
}

export async function listRuns(dir: string): Promise<string[]> {
  return (await readdir(runsDir(dir)).catch(() => [] as string[])).sort();
}
