/**
 * Pure helpers behind the "Core daemon is unavailable" screen: the reason shown for a core exit and
 * the macOS App Translocation hint. Kept free of Electron imports so they are unit-testable.
 */

/** How many trailing stderr lines the supervisor keeps per spawn to explain an exit. */
export const STDERR_TAIL_LINES = 5;
/**
 * A stderr line counts as the exit diagnostic only when written this close to the exit. The core's
 * fatal path writes the error and exits at once; a line from hours earlier (`info fabdesk-core
 * listening`) must not be presented as the cause of a later signal kill or native crash.
 */
export const STDERR_RECENT_MS = 5_000;
const MAX_REASON_DETAIL = 300;

/** Keeps the last `STDERR_TAIL_LINES` non-empty lines of a child's stderr with the time they arrived. */
export class StderrTail {
  private lines: { line: string; at: number }[] = [];

  push(line: string, now = Date.now()): void {
    if (line.trim() === "") return;
    this.lines.push({ line, at: now });
    if (this.lines.length > STDERR_TAIL_LINES) this.lines.shift();
  }

  /** The last line written within `STDERR_RECENT_MS` of `now`; null when stderr was quiet before the exit. */
  lastRecent(now = Date.now()): string | null {
    const last = this.lines[this.lines.length - 1];
    return last && now - last.at <= STDERR_RECENT_MS ? last.line : null;
  }
}

/**
 * `core exited (code 1): <last stderr line>` — the core's fatal path writes the error message as its
 * last stderr line (apps/core/src/main.ts), so surfacing it turns a bare exit code into something a
 * user can report. Structured log lines (`<iso> level  msg {...}`) keep only their message part.
 */
export function coreExitReason(code: number | null, signal: NodeJS.Signals | null, lastStderr: string | null): string {
  const base = `core exited (code ${code ?? signal ?? "?"})`;
  if (!lastStderr) return base;
  const detail = stripLogPrefix(lastStderr).trim();
  if (!detail) return base;
  return `${base}: ${detail.length > MAX_REASON_DETAIL ? `${detail.slice(0, MAX_REASON_DETAIL - 1)}…` : detail}`;
}

/** `2026-09-10T08:57:49.740Z error fatal {...}` → `error fatal {...}`. */
function stripLogPrefix(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "");
}

/**
 * macOS runs a quarantined app that was never moved with Finder from a read-only, randomised
 * mount (`/private/var/folders/.../AppTranslocation/<uuid>/d/fabPlane.app`). The core and the
 * bundled KiCad then live on that mount too, and every launch gets a fresh path.
 */
export function isTranslocated(execPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && execPath.includes("/AppTranslocation/");
}

export const TRANSLOCATION_HINT =
  "fabPlane is running from a quarantined download location (macOS App Translocation). Move fabPlane.app to /Applications with Finder and relaunch.";

/** Appends the translocation hint to a crash message when it applies. */
export function withTranslocationHint(message: string, execPath: string, platform: NodeJS.Platform = process.platform): string {
  return isTranslocated(execPath, platform) ? `${message}\n${TRANSLOCATION_HINT}` : message;
}
