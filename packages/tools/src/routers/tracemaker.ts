import { spawn } from "node:child_process";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { layout } from "@fabdesk/board-workflow";
import { PROJECT_FILES } from "../fs";
import type { RouteProgress, RouteSummary } from "../services";

/** Run `binary args`, collecting stdout and stderr; rejects on spawn errors only. */
function run(binary: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      // the summary is near the end; keep the tail of a long log only
      stdout = (stdout + chunk.toString()).slice(-64 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

const keepOffSupport = new Map<string, Promise<boolean>>();
/**
 * Whether this TraceMaker's `route` offers `--keep-vias-off-pads` (older builds do not). The answer is cached per binary
 * and version of the file (path, size, mtime), so an updated install is asked again; a probe that fails or times out
 * (10 s) answers no and is not cached. The caller's abort stops it.
 */
export async function traceMakerKeepsViasOffPads(binary: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const st = await stat(binary).catch(() => null);
  signal?.throwIfAborted(); // a cancel during the stat
  const key = `${binary}|${st?.size ?? "?"}|${st?.mtimeMs ?? "?"}`;
  let answer = keepOffSupport.get(key);
  if (!answer) {
    // the shared probe is bounded by its own timeout only: one caller's cancel must not answer for another
    const timeout = AbortSignal.timeout(10_000);
    const probe = run(binary, ["route", "--help"], timeout).then(
      (r) => (timeout.aborted ? null : layout.tracemakerKeepsViasOffPads(r.stdout + r.stderr)),
      () => null,
    );
    const shared = probe.then((v) => v ?? false);
    answer = shared;
    keepOffSupport.set(key, shared);
    // a failed or timed-out probe is not an answer: ask again next time
    void probe.then((v) => {
      if (v === null && keepOffSupport.get(key) === shared) keepOffSupport.delete(key);
    });
  }
  if (!signal) return answer;
  // this caller's cancel ends its own wait (the listener goes once the answer is in)
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<boolean>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([answer, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** TraceMaker's own count from its `routed N/M connections` summary line; null when it printed none. */
export function traceMakerRouted(log: string): { routed: number; total: number } | null {
  const m = /^routed (\d+)\/(\d+) connections/m.exec(log);
  return m ? { routed: Number(m[1]), total: Number(m[2]) } : null;
}

/**
 * Run a local TraceMaker CLI against a snapshot board.
 * `tracemaker route in.kicad_pcb -o out.kicad_pcb --time <s>`, plus `--keep-vias-off-pads --vias-off-pads-below 1000`
 * when `keepViasOffPads` (the via-in-pad policy is avoid) and this TraceMaker has the option.
 */
export async function runTraceMaker(opts: {
  binary: string;
  snapshotDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: RouteProgress) => void;
  /** Keep vias off every SMD pad (the requirements do not allow via-in-pad). */
  keepViasOffPads?: boolean;
}): Promise<RouteSummary & { viasOffPads: "kept off" | "not supported" | "not asked" }> {
  const input = join(opts.snapshotDir, PROJECT_FILES.boardPcb);
  const work = join(opts.snapshotDir, "tracemaker");
  await mkdir(work, { recursive: true });
  const output = join(work, "routed.kicad_pcb");
  const started = Date.now();
  const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const keepOff = opts.keepViasOffPads ? await traceMakerKeepsViasOffPads(opts.binary, opts.signal) : false;
  opts.onProgress?.({
    state: "routing",
    phase: "tracemaker",
    message: `TraceMaker ${opts.binary}`,
    log: [],
  });
  const r = await run(
    opts.binary,
    ["route", input, "-o", output, "--time", String(seconds), "--no-kb", ...(keepOff ? layout.TM_KEEP_VIAS_OFF_PADS : [])],
    opts.signal,
  );
  if (opts.signal?.aborted) throw new Error("TraceMaker cancelled");
  // TraceMaker uses 0 for success and 3 for partial routing.
  if (r.code !== 0 && r.code !== 3)
    throw new Error(`TraceMaker exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-400)}` : ""}`);
  await copyFile(output, input);
  const wallMs = Date.now() - started;
  const claimed = traceMakerRouted(r.stdout + "\n" + r.stderr);
  const viasOffPads = !opts.keepViasOffPads ? "not asked" : keepOff ? "kept off" : "not supported";
  return {
    tracks: 0,
    vias: 0,
    claimedVias: 0,
    routed: claimed?.routed ?? 0,
    total: claimed?.total ?? 0,
    trackLengthNm: 0,
    elapsedMs: wallMs,
    wallMs,
    timedOut: wallMs >= opts.timeoutMs,
    message: "Autoroute (tracemaker)",
    unrouted: [],
    log: [
      ...(claimed ? [`TraceMaker claimed ${claimed.routed}/${claimed.total} connections routed (its own count)`] : []),
      ...(viasOffPads === "kept off" ? [`TraceMaker: ${layout.TM_KEEP_VIAS_OFF_PADS.join(" ")} (via-in-pad not allowed)`] : []),
      ...(viasOffPads === "not supported" ? ["TraceMaker: this build has no --keep-vias-off-pads; vias in pads are checked after routing"] : []),
    ],
    viasOffPads,
  };
}
