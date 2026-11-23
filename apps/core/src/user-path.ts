/**
 * A desktop app started from Finder, the Dock or a Linux launcher inherits the session's `PATH`
 * (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), not the one the user's shell builds. Agent CLIs
 * installed by Homebrew, npm, nvm, … are then invisible to detection, and the tools an agent runs
 * are missing too. The daemon therefore adopts the user's `PATH` once at startup: the usual
 * common install folders (`commonBinDirs`) immediately, then whatever the login shell reports.
 */
import { commonBinDirs } from "@fabdesk/agents";
import { existsSync } from "node:fs";
import { basename, delimiter } from "node:path";
import { errMsg, logger } from "./log";

const SHELL_TIMEOUT_MS = 5_000;
const START = "__FABDESK_PATH_START__";
const END = "__FABDESK_PATH_END__";
const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

/**
 * Set to `off` to leave the daemon's `PATH` exactly as inherited: no login shell is started and
 * nothing is appended, so agents run with the launcher's environment. It does not turn off agent
 * detection's own lookup in the common install folders (`resolveBinary` in `@fabdesk/agents`);
 * that reads no environment and changes none.
 */
export const USER_PATH_ENV = "FABDESK_USER_PATH";

function entries(path: string | undefined, sep: string): string[] {
  return (path ?? "").split(sep).filter((entry) => entry !== "");
}

/**
 * Entries only the inherited `PATH` has come first (a launcher or an activated environment put
 * them there on purpose), then the shell's `PATH` in the shell's order, then the fallbacks.
 */
export function mergePath(
  inherited: string | undefined,
  shellPath: string | undefined,
  fallbacks: string[] = [],
  sep: string = delimiter,
): string {
  const shell = entries(shellPath, sep);
  const inShell = new Set(shell);
  const own = entries(inherited, sep);
  const ordered = shell.length ? [...own.filter((entry) => !inShell.has(entry)), ...shell] : own;
  return [...new Set([...ordered, ...fallbacks])].join(sep);
}

/** The command that makes `shell` print its `PATH` between the markers; undefined for shells we do not know. */
export function shellPathCommand(shell: string): string[] | undefined {
  const name = basename(shell);
  if (name === "fish")
    return [shell, "-ilc", `printf '%s' ${START}(string join : $PATH)${END}`];
  if (POSIX_SHELLS.has(name)) return [shell, "-ilc", `printf '%s' "${START}\${PATH}${END}"`];
  return undefined;
}

/** Text between the markers; shell startup files may print around them. */
export function parseShellPath(output: string): string | undefined {
  const start = output.lastIndexOf(START);
  const end = output.indexOf(END, start);
  if (start < 0 || end < 0) return undefined;
  return output.slice(start + START.length, end).trim() || undefined;
}

/** `PATH` as the user's interactive login shell sees it. */
export async function readLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = SHELL_TIMEOUT_MS,
): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const shell = env["SHELL"]?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const command = shellPathCommand(shell);
  if (!command || !existsSync(shell)) return undefined;
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") childEnv[key] = value;
  // An interactive shell must not stop to ask about a framework update.
  childEnv["DISABLE_AUTO_UPDATE"] = "true";
  const proc = Bun.spawn(command, { env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  // The deadline covers the read itself: a profile that leaves a background process holding stdout
  // keeps the pipe open after the shell is gone, so the shell's exit cannot be what ends the wait.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  let output = "";
  try {
    while (parseShellPath(output) === undefined) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "timeout" || next.done) break;
      output += decoder.decode(next.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    proc.kill("SIGKILL");
    void reader.cancel().catch(() => {});
  }
  return parseShellPath(output);
}

let ready: Promise<void> = Promise.resolve();

/** Resolves once the login shell's `PATH` has been adopted (immediately when nothing is pending). */
export function userPathReady(): Promise<void> {
  return ready;
}

/**
 * Extends `env.PATH` in place. The common install folders are added before this returns; the login
 * shell is asked in the background so a slow shell profile never delays startup.
 */
export function adoptUserPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === "win32" || env[USER_PATH_ENV] === "off") return ready;
  const inherited = env["PATH"];
  const fallbacks = commonBinDirs().filter((dir) => existsSync(dir));
  env["PATH"] = mergePath(inherited, undefined, fallbacks);
  ready = readLoginShellPath(env)
    .then((shellPath) => {
      if (shellPath) env["PATH"] = mergePath(inherited, shellPath, fallbacks);
      else logger.info("login shell PATH unavailable; using well-known folders");
    })
    .catch((e: unknown) => logger.warn("login shell PATH lookup failed", { error: errMsg(e) }));
  return ready;
}
