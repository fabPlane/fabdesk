/**
 * Engines are programs the workflow runs, not workflow: KiCadRoutingTools (placer and router), TraceMaker, Freerouting.
 * This file is the thin edge to them: how a process is run (injectable, so the stages are testable with fakes), and the
 * KiCadRoutingTools command lines. Nothing here installs anything; locations come from the caller (settings, env, the
 * router registry of the tools package).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { join, posix, win32 } from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Combined stdout+stderr goes here. */
  log: string;
  /** Read stdin from this file. */
  stdin?: string;
  /** Write stdout here instead of the log (stderr still goes to the log). */
  stdout?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with the pid once started (the governor tracks its memory). */
  onPid?: (pid: number) => void;
}
export interface RunResult {
  code: number;
  wallS: number;
}
export type Spawn = (cmd: string[], opts: RunOptions) => Promise<RunResult>;

const NICE = ["/usr/bin/nice", "/bin/nice"];
let niceBin: string | null | undefined;

/**
 * How to start `cmd` at low priority: through `nice -n 5` where `nice` exists (Linux, macOS; it applies from exec, so
 * children the engine forks inherit it), otherwise directly and lowered after spawn with `os.setPriority` (Windows:
 * BELOW_NORMAL, which child processes inherit too).
 */
export function lowPriority(cmd: string[], o: { platform?: NodeJS.Platform; nice?: string | null } = {}): { argv: string[]; setPriority: number | null } {
  const platform = o.platform ?? process.platform;
  const nice = platform === "win32" ? null : o.nice !== undefined ? o.nice : (niceBin ??= NICE.find((p) => existsSync(p)) ?? null);
  if (nice) return { argv: [nice, "-n", "5", ...cmd], setPriority: null };
  return { argv: cmd, setPriority: platform === "win32" ? constants.priority.PRIORITY_BELOW_NORMAL : 5 };
}

/** Run a command at low priority (`nice -n 5` as the toolkit did, or the OS priority API), logging to a file. 124 on timeout. */
export const nodeRun: Spawn = (cmd, o) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const log = createWriteStream(o.log);
    const out = o.stdout ? createWriteStream(o.stdout) : null;
    const lp = lowPriority(cmd);
    const child = nodeSpawn(lp.argv[0]!, lp.argv.slice(1), {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.pid && lp.setPriority !== null) {
      try {
        setPriority(child.pid, lp.setPriority);
      } catch {
        /* priority is a courtesy; the job runs either way */
      }
    }
    if (child.pid) o.onPid?.(child.pid);
    if (o.stdin) createReadStream(o.stdin).pipe(child.stdin!);
    child.stdout!.on("data", (c: Buffer) => (out ?? log).write(c));
    child.stderr!.on("data", (c: Buffer) => log.write(c));
    let timedOut = false;
    const timer = o.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), o.timeoutMs) : null;
    const abort = () => child.kill("SIGTERM");
    o.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      if (timedOut) log.write(`\nTIMEOUT after ${Math.round((o.timeoutMs ?? 0) / 1000)} s\n`);
      const result = { code: timedOut ? 124 : (code ?? 1), wallS: Math.round((Date.now() - t0) / 100) / 10 };
      // resolve once the log (and stdout file) are flushed: callers read them straight away
      const ended = (w: NodeJS.WritableStream | null) => (w ? new Promise<void>((r) => w.end(r)) : Promise.resolve());
      void Promise.all([ended(log), ended(out)]).then(() => resolve(result));
    });
  });

// ---------------------------------------------------------------- KiCadRoutingTools

export interface KrtPaths {
  root: string;
  plugins: string;
  python: string[];
}

/**
 * KRT build layout: `src/plugins` holds its scripts, the venv's interpreter runs them (`-E -s`: no user site, no env).
 * The venv interpreter is `venv/bin/python` on POSIX and `venv\Scripts\python.exe` on Windows.
 */
export function krtPaths(root: string, platform: NodeJS.Platform = process.platform): KrtPaths {
  const p = platform === "win32" ? win32 : posix;
  const python = platform === "win32" ? p.join(root, "venv", "Scripts", "python.exe") : p.join(root, "venv", "bin", "python");
  return { root, plugins: p.join(root, "src", "plugins"), python: [python, "-E", "-s"] };
}

/** The last `JSON_SUMMARY:` line of a placer log, as the `final` block. */
export function placerSummary(log: string): Record<string, unknown> {
  for (const line of log.split("\n").reverse()) {
    if (line.startsWith("JSON_SUMMARY:")) {
      try {
        return ((JSON.parse(line.slice("JSON_SUMMARY:".length)) as { final?: Record<string, unknown> }).final ?? {}) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }
  return {};
}

/** Per-stage summary lines KRT prints (`JSON_SUMMARY_MIN`, `JSON_IMPROVEMENT_GATE`, pair counts). */
export function routeSummaries(log: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of log.split("\n")) {
    for (const tag of ["JSON_SUMMARY_MIN", "JSON_IMPROVEMENT_GATE"]) {
      if (line.startsWith(tag + ":")) {
        try {
          out[tag] = JSON.parse(line.slice(tag.length + 1));
        } catch {
          /* not JSON */
        }
      }
    }
    if (line.startsWith("JSON_SUMMARY:") && line.includes("routed_diff_pairs")) {
      try {
        const d = JSON.parse(line.slice("JSON_SUMMARY:".length)) as Record<string, unknown>;
        out["pairs"] = Object.fromEntries(["routed_diff_pairs", "failed_diff_pairs", "uncoupled_diff_pairs", "single_ended_diff_pairs", "member_incomplete_pairs"].map((k) => [k, d[k] ?? null]));
      } catch {
        /* not JSON */
      }
    }
  }
  return out;
}

/** KRT's router tools by file name (`route`, `route_diff`, `route_planes`, ...). */
export const krtRouterScript = (k: KrtPaths, tool: string) => join(k.plugins, "py_router", `${tool}.py`);
export const krtMakeUnplaced = (k: KrtPaths) => join(k.plugins, ".claude/skills/plan-pcb-placement/scripts/make_unplaced.py");
export const krtCheckFloorplan = (k: KrtPaths) => join(k.plugins, "py_tools/check_floorplan.py");
export const krtCheckGroups = (k: KrtPaths) => join(k.plugins, "py_tools/check_groups.py");
export const krtPlaceSimple = (k: KrtPaths) => join(k.plugins, "py_placer/place_simple.py");
