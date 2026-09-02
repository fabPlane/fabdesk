import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DetectResult } from "./types";

const VERSION_TIMEOUT_MS = 15_000;

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a command name or path to an executable, honoring the current `PATH`. */
export function resolveBinary(candidate: string): string | undefined {
  const expanded = expandHome(candidate);
  const looksLikePath = expanded.includes("/") || expanded.includes("\\") || isAbsolute(expanded);
  if (looksLikePath) return isExecutableFile(expanded) ? expanded : undefined;
  const found = Bun.which(expanded, { PATH: process.env["PATH"] ?? "" });
  return found ?? undefined;
}

/** Runs `<bin> <args>` and extracts the first dotted version number from its output. */
export async function readVersion(
  bin: string,
  args: string[] = ["--version"],
): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(out + "\n" + err);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Finds the first installed candidate. An explicit `binaryPath` (from Settings) wins and is the only
 * thing checked when given.
 */
export async function detectBinary(
  candidates: string[],
  binaryPath?: string,
  versionArgs: string[] = ["--version"],
): Promise<DetectResult> {
  const list = binaryPath && binaryPath.trim() !== "" ? [binaryPath] : candidates;
  for (const candidate of list) {
    const path = resolveBinary(candidate);
    if (!path) continue;
    const version = await readVersion(path, versionArgs);
    return { installed: true, path, ...(version ? { version } : {}) };
  }
  return { installed: false };
}
