import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PROJECT_FILES } from "../fs";
import type { RouteProgress, RouteSummary } from "../services";

const WINDOWS_SAVE_RETRIES = 20;
const WINDOWS_SAVE_RETRY_MS = 50;

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
}): Promise<RouteSummary> {
  const input = join(opts.snapshotDir, PROJECT_FILES.boardPcb);
  const checkCancelled = () => {
    if (opts.signal?.aborted) throw new Error("TraceMaker cancelled");
  };
  checkCancelled();
  // Retries may share a snapshot, including one with a previous router's output.
  const work = await mkdtemp(join(opts.snapshotDir, ".tracemaker-"));
  const output = join(work, "routed.kicad_pcb");
  const started = Date.now();
  const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  let routeMs: number;
  try {
    opts.onProgress?.({
      state: "routing",
      phase: "tracemaker",
      message: `TraceMaker ${opts.binary}`,
      log: [],
    });
    checkCancelled();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        opts.binary,
        ["route", input, "-o", output, "--time", String(seconds), "--no-kb"],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      const onAbort = () => { child.kill("SIGTERM"); };
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
    routeMs = Date.now() - started;
    checkCancelled();
    const board = lstatSync(output, { throwIfNoEntry: false });
    if (!board?.isFile() || board.size === 0) throw new Error("TraceMaker produced no routed board for this attempt");
    // Windows can briefly refuse to replace a board that a reader still has open.
    for (let retries = 0; ; retries++) {
      checkCancelled();
      try {
        await rename(output, input);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== "win32" ||
          retries >= WINDOWS_SAVE_RETRIES ||
          !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")
        ) {
          throw error;
        }
      }
      await delay(WINDOWS_SAVE_RETRY_MS);
    }
  } finally {
    // A cleanup failure must not turn an already published board into a failed route.
    await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
  const wallMs = Date.now() - started;
  return {
    tracks: 0,
    vias: 0,
    claimedVias: 0,
    routed: 0,
    total: 0,
    trackLengthNm: 0,
    elapsedMs: routeMs,
    wallMs,
    timedOut: routeMs >= opts.timeoutMs,
    message: "Autoroute (tracemaker)",
    unrouted: [],
    log: [],
  };
}
