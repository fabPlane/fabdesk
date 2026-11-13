/**
 * Disk housekeeping for the board workflow's own folders (the toolkit's tools/clean.py, for `<project>/.fabdesk/board/`).
 * A plan first: what can go, how big, and why it is safe; nothing is deleted until `applyClean`.
 *
 * Removed (reproducible copies the stages make):
 * - review runs beyond the newest `keep` (the run `latest.json` names is always kept);
 * - edit candidates (`edits/<id>-<time>`) that can no longer be adopted: the project board is no longer the board the
 *   candidate was computed from (`before/<board>`), or a sheet changed since (`origin.json`); and old score caches
 *   (`edits/.before/`, the newest kept);
 * - board backups of adopts (`adopt/<time>/before`) beyond the newest `keep` (each adopt also took a checkpoint);
 * - layout seed boards (`place/seeds-*`), seed routes (`rank/s*`) and the route stage's losing alternatives, once the
 *   workspace's route stage has finished (its winning board is kept); a workspace still in progress is left alone;
 * - last-mile try folders that are not an accepted step, and the bench's `cache` / `views` (as `board_route prune`);
 * - one-shot adopt inputs (`upgrade/`, `layout/courtyards/`, `release/vias/` boards) and Gerber check pictures
 *   (`release/gerb-*`, `release/cam-*`) beyond the newest `keep`.
 *
 * Kept always: requirements, onboarding, A1-A9 history, review records, dispositions and intent, layout specs, bases and
 * groups, BOM evidence, every accepted last-mile step, candidates that can still be adopted. Nothing outside
 * `.fabdesk/board/` is touched.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { boardHome } from "./files";

export interface CleanItem {
  /** Project-relative path. */
  path: string;
  bytes: number;
  why: string;
}

export interface CleanPlan {
  remove: CleanItem[];
  kept: Array<{ path: string; why: string }>;
  bytes: number;
}

async function dirBytes(p: string): Promise<number> {
  const st = await lstat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await readdir(p).catch(() => [] as string[])) total += await dirBytes(join(p, e));
  return total;
}

const isDir = async (p: string) => (await lstat(p).catch(() => null))?.isDirectory() ?? false;
const subdirs = async (p: string) => {
  const out: string[] = [];
  for (const e of (await readdir(p).catch(() => [] as string[])).sort()) if (await isDir(join(p, e))) out.push(e);
  return out;
};
const sha = async (p: string) => {
  const b = await readFile(p).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};
const readJson = async <T>(p: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
};
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.ceil(n / 1e3)} kB`);

/** Absolute path strings anywhere in a JSON value. */
function pathsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) out.push(resolve(v));
    for (const m of v.matchAll(/\((\/[^()]+)\)/g)) out.push(resolve(m[1]!));
  } else if (Array.isArray(v)) for (const x of v) pathsIn(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) pathsIn(x, out);
  return out;
}
const holds = (dir: string, paths: readonly string[]) => paths.some((p) => p === dir || p.startsWith(dir + sep));

/** What `applyClean` would remove under `<project>/.fabdesk/board/`, and what it keeps, with the reason for each. */
export async function cleanPlan(projectDir: string, opts: { keep?: number } = {}): Promise<CleanPlan> {
  const keep = Math.max(1, opts.keep ?? 3);
  const home = boardHome(projectDir);
  const rel = (p: string) => relative(projectDir, p).split(sep).join("/");
  const remove: Array<{ abs: string; why: string }> = [];
  const kept: CleanPlan["kept"] = [];
  const keepNewest = async (dir: string, names: string[], why: (n: number) => string) => {
    const sorted = [...names].sort();
    for (const n of sorted.slice(0, Math.max(0, sorted.length - keep))) remove.push({ abs: join(dir, n), why: why(keep) });
  };

  // review runs beyond the newest `keep`; the latest run is always kept
  const runs = join(home, "review", "runs");
  const latest = (await readJson<{ run?: string }>(join(home, "review", "latest.json")))?.run;
  const runNames = (await subdirs(runs)).filter((n) => n !== latest);
  await keepNewest(runs, runNames, (k) => `older review run (the latest and the newest ${k} are kept; review records are rebuilt by board_review run)`);
  if (latest) kept.push({ path: rel(join(runs, latest)), why: "the latest review run" });

  // edit candidates that can no longer be adopted, and old before-score caches
  const edits = join(home, "edits");
  for (const c of await subdirs(edits)) {
    const dir = join(edits, c);
    if (c === ".before") {
      const caches = await subdirs(dir);
      const withTime = await Promise.all(caches.map(async (n) => [n, (await lstat(join(dir, n))).mtimeMs] as const));
      withTime.sort((a, b) => a[1] - b[1]);
      for (const [n] of withTime.slice(0, -1)) remove.push({ abs: join(dir, n), why: "score cache of an earlier design (recomputed on the next edit)" });
      continue;
    }
    if (c.startsWith(".")) continue;
    const pcbName = (await readdir(join(dir, "before")).catch(() => [] as string[])).find((n) => n.endsWith(".kicad_pcb"));
    if (!pcbName) {
      kept.push({ path: rel(dir), why: "edit candidate without a recorded source board (not judged)" });
      continue;
    }
    const [was, now] = await Promise.all([sha(join(dir, "before", pcbName)), sha(join(projectDir, pcbName))]);
    const origin = await readJson<{ files?: Record<string, string> }>(join(dir, "origin.json"));
    const sheetMoved: string[] = [];
    for (const [n, h] of Object.entries(origin?.files ?? {})) {
      const cur = await sha(join(projectDir, n));
      if (cur !== h && cur !== (await sha(join(dir, n)))) sheetMoved.push(n);
    }
    if (was !== now) remove.push({ abs: dir, why: `edit candidate for an earlier ${pcbName} (the board changed since, by this adopt or another): it can no longer be adopted` });
    else if (sheetMoved.length) remove.push({ abs: dir, why: `edit candidate computed before ${sheetMoved.join(", ")} changed: adopt refuses it` });
    else kept.push({ path: rel(dir), why: "edit candidate of the board as it is: can still be adopted" });
  }

  // adopt backups beyond the newest `keep`
  const adopt = join(home, "adopt");
  await keepNewest(adopt, await subdirs(adopt), (k) => `board backup of an older adopt (the newest ${k} are kept; each adopt also took a checkpoint)`);

  // layout workspaces: seed boards and routes once the route stage finished
  const layout = join(home, "layout");
  for (const w of await subdirs(layout)) {
    const ws = join(layout, w);
    const flow = await readJson<{ stages?: Record<string, { status?: string; result?: unknown; verdict?: string }>; best_board?: unknown }>(join(ws, "flow.json"));
    if (!flow) continue;
    const route = flow.stages?.["route"];
    if (!route || !["pass", "stop"].includes(route.status ?? "")) {
      kept.push({ path: rel(ws), why: "layout workspace in progress (the route stage has not passed or stopped): its seeds are still inputs" });
      continue;
    }
    // the board the route stage chose (named in its verdict) and the last mile's input (flow.best_board) stay; the
    // stage's result lists every alternative, so it does not decide
    const winners = pathsIn([route.verdict, flow.best_board]);
    for (const n of await subdirs(join(ws, "place")))
      if (n.startsWith("seeds-") && !holds(join(ws, "place", n), winners)) remove.push({ abs: join(ws, "place", n), why: "placer seed boards: the route stage has finished (place again makes new ones)" });
    for (const n of await subdirs(join(ws, "rank")))
      if (/^s\d+$/.test(n) && !holds(join(ws, "rank", n), winners)) remove.push({ abs: join(ws, "rank", n), why: "seed route of the rank stage: the route stage has finished" });
    for (const n of await subdirs(join(ws, "route"))) {
      const d = join(ws, "route", n);
      if (holds(d, winners)) kept.push({ path: rel(d), why: "the route stage's winning board" });
      else remove.push({ abs: d, why: "route stage alternative that did not win" });
    }
  }

  // last-mile workspaces: try folders that are not an accepted step, the bench caches
  const lastmile = join(home, "lastmile");
  for (const w of await subdirs(lastmile)) {
    const ws = join(lastmile, w);
    const st = await readJson<{ history?: Array<{ dir?: string }> }>(join(ws, "state.json"));
    if (!st) continue;
    const steps = (st.history ?? []).map((h) => resolve(h.dir ?? ""));
    for (const t of await subdirs(ws)) {
      if (!/^t\d+$/.test(t)) continue;
      for (const c of await subdirs(join(ws, t))) {
        const d = resolve(ws, t, c);
        if (!holds(d, steps)) remove.push({ abs: d, why: "last-mile try that was not accepted (as board_route prune)" });
      }
    }
    for (const x of ["cache", "views"]) if (await isDir(join(ws, x))) remove.push({ abs: join(ws, x), why: "last-mile bench cache / pictures (rebuilt on demand)" });
    kept.push({ path: rel(ws), why: `${steps.length} accepted last-mile step(s)` });
  }

  // one-shot adopt inputs and check pictures
  for (const d of [join(home, "upgrade"), join(home, "release", "vias")]) {
    if (!(await isDir(d))) continue;
    const names = (await readdir(d)).sort();
    if (d.endsWith("upgrade")) await keepNewest(d, names, (k) => `upgraded copy of an earlier board (the project board holds the upgrade; the newest ${k} kept)`);
    else for (const n of names) if (n.endsWith(".kicad_pcb")) remove.push({ abs: join(d, n), why: "input of a finished board_release vias adopt (recomputed in seconds)" });
  }
  if (await isDir(join(layout, "courtyards"))) remove.push({ abs: join(layout, "courtyards"), why: "input of a finished board_route courtyards adopt (recomputed in seconds)" });
  const rel_ = join(home, "release");
  for (const prefix of ["gerb-", "cam-"]) await keepNewest(rel_, (await subdirs(rel_)).filter((n) => n.startsWith(prefix)), (k) => `Gerber check pictures of an earlier run (the newest ${k} kept)`);

  const items: CleanItem[] = [];
  const seen = new Set<string>();
  for (const r of remove) {
    if (seen.has(r.abs) || !resolve(r.abs).startsWith(resolve(home) + sep)) continue;
    seen.add(r.abs);
    items.push({ path: rel(r.abs), bytes: await dirBytes(r.abs), why: r.why });
  }
  items.sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1));
  return { remove: items, kept, bytes: items.reduce((t, i) => t + i.bytes, 0) };
}

/** Delete what the plan lists (paths inside `.fabdesk/board/` only). */
export async function applyClean(projectDir: string, plan: CleanPlan): Promise<{ removed: number; bytes: number }> {
  const home = resolve(boardHome(projectDir));
  let removed = 0;
  let bytes = 0;
  for (const it of plan.remove) {
    const abs = resolve(projectDir, it.path);
    if (!abs.startsWith(home + sep)) continue;
    await rm(abs, { recursive: true, force: true });
    removed++;
    bytes += it.bytes;
  }
  return { removed, bytes };
}

/** The plan as report lines (the largest first). */
export function cleanLines(plan: CleanPlan, max = 25): string[] {
  const lines = [`${plan.remove.length} folder(s)/file(s), ${fmtBytes(plan.bytes)} reproducible:`];
  for (const it of plan.remove.slice(0, max)) lines.push(`  ${fmtBytes(it.bytes).padStart(8)}  ${it.path}  (${it.why})`);
  if (plan.remove.length > max) lines.push(`  ... ${plan.remove.length - max} more`);
  return lines;
}

export { fmtBytes as cleanBytes };
