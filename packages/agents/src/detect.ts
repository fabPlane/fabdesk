import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

/**
 * npm's Windows shims (`claude.cmd`) are batch files that `Bun.spawn` cannot start (runs die with exit -1
 * before the CLI runs). They only forward to a real executable next to them
 * (`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`), so resolve to that instead.
 */
export function resolveWindowsShim(path: string): string | undefined {
  if (!/\.(cmd|bat)$/i.test(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const m = /"%(?:dp0|~dp0)%[\\/]?([^"]+\.(?:exe|cmd|bat))"/i.exec(text);
  if (!m?.[1]) return undefined;
  const target = join(dirname(path), m[1]);
  if (/\.(cmd|bat)$/i.test(target) || !isExecutableFile(target)) return undefined;
  return target;
}

/** Resolves a command name or path to an executable, honoring the current `PATH`. */
export function resolveBinary(candidate: string): string | undefined {
  const expanded = expandHome(candidate);
  const looksLikePath = expanded.includes("/") || expanded.includes("\\") || isAbsolute(expanded);
  let found: string | undefined;
  if (looksLikePath) found = isExecutableFile(expanded) ? expanded : undefined;
  else found = Bun.which(expanded, { PATH: process.env["PATH"] ?? "" }) ?? undefined;
  if (found && process.platform === "win32") return resolveWindowsShim(found) ?? found;
  return found;
}

/** First installed candidate, synchronously (no version probe); what adapters spawn when no path is configured. */
export function resolveFirst(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const path = resolveBinary(candidate);
    if (path) return path;
  }
  return undefined;
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
