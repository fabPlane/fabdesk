/**
 * `RunChild` for the core: a heavy board computation runs in a child process that is this same program started with the
 * hidden `board-child` subcommand (the compiled binary in a packaged app, `bun main.ts` in development). Input and result
 * pass as JSON files; progress comes back as stdout lines `@@progress {...}`. Cancel kills the child. See
 * `@fabdesk/tools` `child-tasks.ts` for the tasks and why they leave the daemon.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildTaskError, runChildTask, type RunChild } from "@fabdesk/tools";
import { killTree } from "./workflow-adopt";

const PROGRESS = "@@progress ";

/** How to start this program again: the binary alone when compiled, the runtime plus the entry script in development. */
export function selfCommand(execPath = process.execPath, main = Bun.main): string[] {
  return /\.(ts|js|mjs)$/.test(main) && existsSync(main) ? [execPath, main] : [execPath];
}

export function createRunChild(command: string[] = selfCommand()): RunChild {
  return async (task, input, opts) => {
    opts.signal?.throwIfAborted();
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-child-"));
    const inFile = join(dir, "in.json");
    const outFile = join(dir, "out.json");
    try {
      await writeFile(inFile, JSON.stringify(input));
      // its own process group (POSIX), so cancel stops the child AND what it started (kicad-cli's scoring DRC); stdin stays
      // open for the child's lifetime: when this process dies, the pipe closes and the child stops its group itself
      const proc = spawn(command[0]!, [...command.slice(1), "board-child", task, inFile, outFile], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: process.env,
        windowsHide: true,
      });
      let force: ReturnType<typeof setTimeout> | null = null;
      const kill = () => {
        killTree(proc, "SIGTERM");
        force = setTimeout(() => killTree(proc, "SIGKILL"), 3000);
      };
      opts.signal?.addEventListener("abort", kill, { once: true });
      let stderr = "";
      proc.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
      let buf = "";
      proc.stdout!.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.startsWith(PROGRESS)) continue;
          try {
            const m = JSON.parse(line.slice(PROGRESS.length)) as { p: number; n: string };
            opts.onProgress?.(m.p, m.n);
          } catch {
            /* a malformed line is not progress */
          }
        }
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", (c) => resolve(c));
      });
      if (force) clearTimeout(force);
      opts.signal?.removeEventListener("abort", kill);
      proc.stdin?.destroy();
      if (opts.signal?.aborted) throw new ChildTaskError("cancelled", "AbortError", "cancelled");
      const out = JSON.parse(await readFile(outFile, "utf8").catch(() => "null")) as { ok: boolean; result?: unknown; error?: string; name?: string; code?: string } | null;
      if (!out) throw new ChildTaskError(`board child ${task} exited with code ${code} and no result${stderr ? `: ${stderr.trim().slice(-600)}` : ""}`, "ChildCrash");
      if (!out.ok) throw new ChildTaskError(out.error ?? "child task failed", out.name ?? "Error", out.code);
      return out.result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** The `board-child` subcommand: run one task from the input file, write the result file. Returns the exit code. */
export async function boardChildMain(task: string, inFile: string, outFile: string): Promise<number> {
  const progress = (p: number, n: string) => process.stdout.write(PROGRESS + JSON.stringify({ p, n }) + "\n");
  // the daemon holds stdin open while it waits; EOF means it is gone: stop this whole group (kicad-cli included)
  process.stdin.on("end", () => {
    if (process.platform !== "win32") {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        /* not a group leader */
      }
    }
    process.exit(1);
  });
  process.stdin.resume();
  try {
    const input = JSON.parse(await readFile(inFile, "utf8")) as unknown;
    const result = await runChildTask(task, input, progress);
    await writeFile(outFile, JSON.stringify({ ok: true, result }));
    return 0;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const raw = (err as unknown as { code?: unknown }).code;
    const code = typeof raw === "string" ? raw : undefined;
    await writeFile(outFile, JSON.stringify({ ok: false, error: err.message, name: err.constructor?.name ?? err.name, ...(code ? { code } : {}) }));
    return 1;
  }
}
