import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { widthRuleOverlay } from "../routing-quality";
import { PROJECT_FILES } from "../fs";
import type { RouteProgress, RouteSummary } from "../services";

/**
 * Run a local TraceMaker CLI against a snapshot board.
 * `tracemaker route in.kicad_pcb -o out.kicad_pcb --time <s>`
 */
export async function runTraceMaker(opts: {
  binary: string;
  snapshotDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: RouteProgress) => void;
  perNet?: Array<{ net: string; widthMm: number }>;
}): Promise<RouteSummary> {
  const rules = join(opts.snapshotDir, "board.kicad_dru");
  const original = opts.perNet?.length ? await readFile(rules, "utf8").catch((e) => { if (e.code === "ENOENT") return null; throw e; }) : undefined;
  if (opts.perNet?.length) await writeFile(rules, (original ?? "(version 1)\n") + widthRuleOverlay(opts.perNet));
  try {
    const input = join(opts.snapshotDir, PROJECT_FILES.boardPcb);
    const work = join(opts.snapshotDir, "tracemaker");
    await mkdir(work, { recursive: true });
    const output = join(work, "routed.kicad_pcb");
    const started = Date.now();
    const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    opts.onProgress?.({
      state: "routing",
      phase: "tracemaker",
      message: `TraceMaker ${opts.binary}`,
      log: [],
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        opts.binary,
        ["route", input, "-o", output, "--time", String(seconds), "--no-kb"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("exit", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) {
          reject(new Error("TraceMaker cancelled"));
          return;
        }
        // TraceMaker uses 0 for success and 3 for partial routing.
        if (code === 0 || code === 3) {
          resolve();
          return;
        }
        reject(new Error(`TraceMaker exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
      });
    });
    await copyFile(output, input);
    const wallMs = Date.now() - started;
    return {
      tracks: 0,
      vias: 0,
      claimedVias: 0,
      routed: 0,
      total: 0,
      trackLengthNm: 0,
      elapsedMs: wallMs,
      wallMs,
      timedOut: wallMs >= opts.timeoutMs,
      message: "Autoroute (tracemaker)",
      unrouted: [],
      log: [],
    };
  } finally {
    if (original === null) await rm(rules, { force: true });
    else if (original !== undefined) await writeFile(rules, original);
  }
}
