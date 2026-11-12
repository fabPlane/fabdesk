/**
 * `RunChild` for the core: a heavy board computation runs in a child process that is this same program started with the
 * hidden `board-child` subcommand (the compiled binary in a packaged app, `bun main.ts` in development). Input and result
 * pass as JSON files; progress comes back as stdout lines `@@progress {...}`. Cancel kills the child. See
 * `@fabdesk/tools` `child-tasks.ts` for the tasks and why they leave the daemon.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildTaskError, runChildTask, type RunChild } from "@fabdesk/tools";

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
      const proc = Bun.spawn([...command, "board-child", task, inFile, outFile], { stdout: "pipe", stderr: "pipe", env: process.env });
      const kill = () => proc.kill();
      opts.signal?.addEventListener("abort", kill, { once: true });
      const readErr = new Response(proc.stderr).text().then((t) => t.slice(-4000), () => "");
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
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
      }
      const code = await proc.exited;
      const stderr = await readErr;
      opts.signal?.removeEventListener("abort", kill);
      if (opts.signal?.aborted) throw new ChildTaskError("cancelled", "AbortError");
      const out = JSON.parse(await readFile(outFile, "utf8").catch(() => "null")) as { ok: boolean; result?: unknown; error?: string; name?: string } | null;
      if (!out) throw new ChildTaskError(`board child ${task} exited with code ${code} and no result${stderr ? `: ${stderr.trim().slice(-600)}` : ""}`, "ChildCrash");
      if (!out.ok) throw new ChildTaskError(out.error ?? "child task failed", out.name ?? "Error");
      return out.result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** The `board-child` subcommand: run one task from the input file, write the result file. Returns the exit code. */
export async function boardChildMain(task: string, inFile: string, outFile: string): Promise<number> {
  const progress = (p: number, n: string) => process.stdout.write(PROGRESS + JSON.stringify({ p, n }) + "\n");
  try {
    const input = JSON.parse(await readFile(inFile, "utf8")) as unknown;
    const result = await runChildTask(task, input, progress);
    await writeFile(outFile, JSON.stringify({ ok: true, result }));
    return 0;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await writeFile(outFile, JSON.stringify({ ok: false, error: err.message, name: err.constructor?.name ?? err.name }));
    return 1;
  }
}
