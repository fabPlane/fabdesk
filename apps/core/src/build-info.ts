/**
 * Which build of fabdesk produced a run, recorded on every run dump's `run.started` event so usage
 * analysis can compare builds (docs/agent-run-telemetry.md).
 *
 * - release: a compiled `fabdesk-core`; commit and dirty flag are baked in by scripts/build.ts.
 * - dev: running from a checkout; commit, branch and dirty flag come from git at startup.
 * - candidate: either of the above launched with FABDESK_BUILD_LABEL, e.g. a benchmark build.
 */
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
type Git = (args: string[]) => string | null;

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
    const status = commit ? opts.git(["status", "--porcelain", "--untracked-files=no"]) : null;
    dirty = status === null ? null : status.length > 0;
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
    ...(compiled ? {} : { git: sourceGit }),
  });
  return cached;
}
