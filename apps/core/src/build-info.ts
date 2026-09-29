/**
 * Which build of fabdesk produced a run, recorded on every run dump's `run.started` event so usage
 * analysis can compare builds (docs/agent-run-telemetry.md).
 *
 * - release: a compiled `fabdesk-core`; commit and dirty flag are baked in by scripts/build.ts.
 * - dev: running from a checkout; commit, branch and dirty flag come from git at startup.
 * - candidate: either of the above launched with FABDESK_BUILD_LABEL, e.g. a benchmark build.
 */
import { readFileSync } from "node:fs";
import { VERSION, channel, type Channel } from "./config";

declare const FABDESK_COMPILED: boolean | undefined;
declare const FABDESK_BUILD_COMMIT: string | undefined;
declare const FABDESK_BUILD_BRANCH: string | undefined;
declare const FABDESK_BUILD_DIRTY: boolean | undefined;
declare const FABDESK_BUILD_TIME: string | undefined;

export type BuildKind = "release" | "candidate" | "dev";

export type BuildInfo = {
  version: string;
  kind: BuildKind;
  /** FABDESK_BUILD_LABEL: a human name for a line of work (`traditional-v2`). */
  label: string | null;
  commit: string | null;
  branch: string | null;
  /** Uncommitted changes were present, so the commit alone does not reproduce the build. */
  dirty: boolean | null;
  channel: Channel;
  builtAt: string | null;
};

export type Baked = { compiled: boolean; commit?: string; branch?: string; dirty?: boolean; builtAt?: string };
export type Git = (args: string[]) => string | null;

const clean = (v: string | null | undefined, max = 64): string | null => {
  const s = v?.trim().replace(/[^\w.+/@-]+/g, "-").slice(0, max);
  return s || null;
};

export function resolveBuildInfo(opts: {
  version: string;
  channel: Channel;
  baked: Baked;
  env?: NodeJS.ProcessEnv;
  git?: Git;
  read?: (path: string) => string | null;
}): BuildInfo {
  const { baked, env = process.env } = opts;
  const label = clean(env["FABDESK_BUILD_LABEL"]);
  let commit = clean(baked.commit, 40);
  let branch = clean(baked.branch);
  let dirty: boolean | null = baked.dirty ?? null;
  if (!baked.compiled && opts.git) {
    commit = clean(opts.git(["rev-parse", "--short", "HEAD"]), 40);
    const ref = opts.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = ref && ref !== "HEAD" ? clean(ref) : null;
    dirty = commit ? worktreeDirty(opts.git, opts.read ?? readText) : null;
  }
  return {
    version: opts.version,
    kind: label ? "candidate" : baked.compiled ? "release" : "dev",
    label,
    commit,
    branch,
    dirty,
    channel: opts.channel,
    builtAt: baked.builtAt ?? null,
  };
}

/** Files `scripts/set-version.ts` rewrites when CI stamps a release version. */
const VERSION_STAMP_FILES = new Set(["package.json", "apps/desktop/package.json", "apps/core/package.json", "apps/mobile/app.json"]);

/** A stamped file's JSON without the fields set-version.ts writes (it also reformats, so compare parsed). */
function unstamped(text: string): unknown {
  const doc = JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  delete doc["version"];
  if (doc["expo"]) {
    delete doc["expo"].version;
    delete doc["expo"].ios?.buildNumber;
    delete doc["expo"].android?.versionCode;
  }
  return doc;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/** True unless `head` and `current` differ only in the release version stamp. */
export function changedBeyondVersion(path: string, head: string | null, current: string | null): boolean {
  if (!VERSION_STAMP_FILES.has(path) || head === null || current === null) return true;
  try {
    return canonical(unstamped(head)) !== canonical(unstamped(current));
  } catch {
    return true;
  }
}

/**
 * Uncommitted changes to tracked files, ignoring the version stamp CI writes just before a release
 * build. Null when git can't tell (not a checkout).
 */
export function worktreeDirty(git: Git, read: (path: string) => string | null): boolean | null {
  const names = git(["diff", "--name-only", "HEAD"]);
  const root = git(["rev-parse", "--show-toplevel"]);
  if (names === null || !root) return null;
  return names
    .split("\n")
    .filter(Boolean)
    .some((f) => changedBeyondVersion(f, git(["show", `HEAD:${f}`]), read(`${root}/${f}`)));
}

export const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** `git -C <this checkout>`; null when git is missing or this is not a checkout. */
function sourceGit(args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", import.meta.dir, ...args], { stdout: "pipe", stderr: "ignore" });
    return proc.success ? proc.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

let cached: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  const compiled = typeof FABDESK_COMPILED === "boolean" && FABDESK_COMPILED;
  cached ??= resolveBuildInfo({
    version: VERSION,
    channel: channel(),
    baked: {
      compiled,
      ...(typeof FABDESK_BUILD_COMMIT === "string" ? { commit: FABDESK_BUILD_COMMIT } : {}),
      ...(typeof FABDESK_BUILD_BRANCH === "string" ? { branch: FABDESK_BUILD_BRANCH } : {}),
      ...(typeof FABDESK_BUILD_DIRTY === "boolean" ? { dirty: FABDESK_BUILD_DIRTY } : {}),
      ...(typeof FABDESK_BUILD_TIME === "string" ? { builtAt: FABDESK_BUILD_TIME } : {}),
    },
    ...(compiled ? {} : { git: sourceGit, read: readText }),
  });
  return cached;
}
