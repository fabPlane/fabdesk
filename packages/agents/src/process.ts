import type { Subprocess } from "bun";
import { readJsonl, readTail } from "./jsonl";
import type { AgentEvent, AgentRun } from "./types";

const TERM_GRACE_MS = 5000;
const KILL_GRACE_MS = 5000;

type Signal = "SIGINT" | "SIGTERM" | "SIGKILL";

/** Lists every descendant of `pid` (deepest last) using `ps`; empty on platforms without it. */
export function descendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  let out = "";
  try {
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    out = ps.stdout.toString();
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const result: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of children.get(current) ?? []) {
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

/** Signals a whole process tree, children before the root so shells cannot re-parent grandchildren. */
export function killTree(pid: number, signal: Signal): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      /* best effort */
    }
    return;
  }
  const targets = [...descendantPids(pid).reverse(), pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {
      /* already gone */
    }
  }
}

function signalPids(pids: readonly number[], signal: Signal): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive) && Date.now() < deadline) await Bun.sleep(50);
}

export interface AgentProcessOptions {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  /** Maps one parsed JSONL value to zero or more events. */
  parse(line: unknown): AgentEvent[];
  /** Session id learned by the parser, reported on `done`. */
  sessionId?(): string | undefined;
  /** Runs after the process has exited (temp files, configs). */
  cleanup?(): void | Promise<void>;
}

/**
 * Spawns an agent CLI and turns its stdout JSONL into `AgentEvent`s. `abort()` sends SIGINT to the
 * process tree (lets the CLI finish the turn), SIGTERM 5 s later, SIGKILL 5 s after that.
 */
export function runAgentProcess(opts: AgentProcessOptions): AgentRun {
  let proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let spawnError: string | undefined;
  try {
    proc = Bun.spawn(opts.cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  let aborted = false;
  let exited = false;
  /**
   * Every PID of the tree seen since abort, so a child re-parented after the root exits (it is no
   * longer the root's descendant) is still reached.
   */
  const abortTargets = new Set<number>();
  const signalAbortTree = (pid: number, signal: Signal) => {
    for (const child of descendantPids(pid).reverse()) abortTargets.add(child);
    abortTargets.add(pid);
    signalPids([...abortTargets], signal);
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };
  const schedule = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      if (!exited) fn();
    }, ms);
    if (typeof t === "object" && t && "unref" in t) t.unref();
    timers.push(t);
  };

  const abort = () => {
    if (!proc || exited || aborted) return;
    aborted = true;
    const pid = proc.pid;
    if (process.platform === "win32") {
      killTree(pid, "SIGINT");
      schedule(TERM_GRACE_MS, () => killTree(pid, "SIGTERM"));
      schedule(TERM_GRACE_MS + KILL_GRACE_MS, () => killTree(pid, "SIGKILL"));
      return;
    }
    signalAbortTree(pid, "SIGINT");
    schedule(TERM_GRACE_MS, () => signalAbortTree(pid, "SIGTERM"));
    schedule(TERM_GRACE_MS + KILL_GRACE_MS, () => signalAbortTree(pid, "SIGKILL"));
  };

  async function* events(): AsyncGenerator<AgentEvent> {
    if (!proc) {
      yield {
        type: "error",
        message: `failed to start ${opts.cmd[0] ?? "agent"}: ${spawnError ?? "unknown error"}`,
      };
      yield { type: "done", exitCode: -1 };
      return;
    }
    const stderrTail = readTail(proc.stderr);
    let sawError = false;
    try {
      for await (const line of readJsonl(proc.stdout)) {
        let mapped: AgentEvent[];
        try {
          mapped = opts.parse(line);
        } catch (err) {
          mapped = [
            {
              type: "error",
              message: `parser error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ];
        }
        for (const ev of mapped) {
          if (ev.type === "error") sawError = true;
          yield ev;
        }
      }
      const exitCode = await proc.exited;
      exited = true;
      // The root CLI may exit on SIGINT while a router/tool child ignores it and is re-parented.
      // Finish off what abort saw before reporting done: `done` releases the run's project lease,
      // and a surviving child could otherwise keep writing next to the project's next run.
      if (aborted) {
        const rootPid = proc.pid;
        const survivors = [...abortTargets].filter((pid) => pid !== rootPid && isAlive(pid));
        if (survivors.length) {
          signalPids(survivors, "SIGTERM");
          await waitForExit(survivors, KILL_GRACE_MS);
          const stubborn = survivors.filter(isAlive);
          signalPids(stubborn, "SIGKILL");
          await waitForExit(stubborn, 1000);
        }
      }
      clearTimers();
      const stderr = (await stderrTail).trim();
      if (exitCode !== 0 && !sawError && !aborted) {
        yield {
          type: "error",
          message:
            stderr !== ""
              ? lastLines(stderr, 20)
              : `${basename(opts.cmd[0] ?? "agent")} exited with code ${exitCode}`,
        };
      }
      yield {
        type: "done",
        exitCode,
        ...(opts.sessionId?.() ? { sessionId: opts.sessionId() as string } : {}),
      };
    } finally {
      exited = true;
      clearTimers();
      if (proc.exitCode === null && proc.signalCode === null) {
        // Consumer stopped iterating early: tear the tree down without waiting for the grace periods.
        killTree(proc.pid, "SIGTERM");
      }
      await opts.cleanup?.();
    }
  }

  return { events: events(), abort, ...(proc ? { pid: proc.pid } : {}) };
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
