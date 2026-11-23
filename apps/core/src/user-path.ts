/**
 * A desktop app started from Finder, the Dock or a Linux launcher inherits the session's `PATH`
 * (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), not the one the user's shell builds. Agent CLIs
 * installed by Homebrew, npm, nvm, … are then invisible to detection, and the tools an agent runs
 * are missing too. The daemon therefore adopts the user's `PATH` once at startup: the usual
 * per-user bin folders immediately, then whatever the login shell reports.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { errMsg, logger } from "./log";

const SHELL_TIMEOUT_MS = 5_000;
const START = "__FABDESK_PATH_START__";
const END = "__FABDESK_PATH_END__";
const POSIX_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh"]);

/** Set to `off` to keep the inherited `PATH` untouched. */
export const USER_PATH_ENV = "FABDESK_USER_PATH";

/** Where package managers put per-user commands; only existing folders are ever added. */
export function wellKnownBinDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") return [];
  const shared = [
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
  ];
  return platform === "darwin"
    ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", ...shared, "/opt/local/bin"]
    : [...shared, "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
}

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
  const proc = Bun.spawn(command, {
    env: childEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return parseShellPath(output);
}

let ready: Promise<void> = Promise.resolve();

/** Resolves once the login shell's `PATH` has been adopted (immediately when nothing is pending). */
export function userPathReady(): Promise<void> {
  return ready;
}

/**
 * Extends `env.PATH` in place. The well-known folders are added before this returns; the login
 * shell is asked in the background so a slow shell profile never delays startup.
 */
export function adoptUserPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === "win32" || env[USER_PATH_ENV] === "off") return ready;
  const inherited = env["PATH"];
  const fallbacks = wellKnownBinDirs().filter((dir) => existsSync(dir));
  env["PATH"] = mergePath(inherited, undefined, fallbacks);
  ready = readLoginShellPath(env)
    .then((shellPath) => {
      if (shellPath) env["PATH"] = mergePath(inherited, shellPath, fallbacks);
      else logger.info("login shell PATH unavailable; using well-known folders");
    })
    .catch((e: unknown) => logger.warn("login shell PATH lookup failed", { error: errMsg(e) }));
  return ready;
}
