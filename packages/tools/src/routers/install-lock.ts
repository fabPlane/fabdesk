/**
 * A cross-process lock for engine installs. The registry's in-memory `inflight` map only joins installs inside one
 * process; two processes (two standalone `fabdesk mcp`, the desktop daemon and a CLI) installing the same engine
 * would otherwise swap and delete each other's install folders and overwrite each other's state.
 *
 * The lock is a file created exclusively (`wx`, atomic on POSIX and Windows) holding the owner's pid, host, start
 * time and a random token. A waiter polls until it is gone, and takes over a stale one: its pid is dead (same
 * host), or it is older than `staleMs`, or it is an unreadable file that has not changed for a while (a holder that
 * died between create and write). Breaking a stale lock is serialized (`takeOver`), so concurrent waiters cannot
 * remove a lock another waiter has just taken. The waiter is bounded by `waitMs` and aborted by `signal`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export type InstallLockHolder = { pid: number; host: string; at: number; token: string };

export type InstallLockOptions = {
  signal?: AbortSignal;
  /** A lock older than this is taken over even when its pid looks alive (default 2 h; a cold KRT build is minutes). */
  staleMs?: number;
  /** How long to wait for a live holder before giving up (default 100 min: a cold arm64 KRT build can take 45). */
  waitMs?: number;
  /** Poll interval while waiting (default 500 ms). */
  pollMs?: number;
  /** Called once when the lock is held by someone else and this caller starts waiting. */
  onWait?: (holder: InstallLockHolder | null) => void;
  /** Tests only: whether a pid on this host is alive. */
  isAlive?: (pid: number) => boolean;
  /** Tests only: the clock. */
  now?: () => number;
};

const UNREADABLE_GRACE_MS = 30_000;

/** Tokens of the locks this process holds now: a lock with this pid and another token is a leftover (a reused pid). */
const heldTokens = new Set<string>();
/** Windows: consecutive permission errors creating a lock that is not there (a folder we cannot write). */
const permissionTries = new Map<string, number>();

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readHolder(path: string): Promise<InstallLockHolder | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<InstallLockHolder>;
    if (typeof raw.pid !== "number" || typeof raw.at !== "number" || typeof raw.token !== "string") return null;
    return { pid: raw.pid, host: typeof raw.host === "string" ? raw.host : "", at: raw.at, token: raw.token };
  } catch {
    return null;
  }
}

async function tryCreate(path: string, holder: InstallLockHolder): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // Windows: a lock file being deleted, or opened by another process, reports these instead; poll again. With no
    // lock file there at all it is a real permission problem: fail after a few tries instead of waiting it out.
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
      const exists = await stat(path).then(() => true, () => false);
      const tries = (permissionTries.get(path) ?? 0) + 1;
      permissionTries.set(path, exists ? 0 : tries);
      if (!exists && tries > 20) {
        permissionTries.delete(path);
        throw error;
      }
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(holder));
  } finally {
    await handle.close();
  }
  return true;
}

/** Whether the lock at `path` (holder already read) is stale. */
async function isStale(path: string, holder: InstallLockHolder | null, opts: InstallLockOptions): Promise<boolean> {
  const now = (opts.now ?? Date.now)();
  if (!holder) {
    try {
      return now - (await stat(path)).mtimeMs > UNREADABLE_GRACE_MS;
    } catch {
      return false; // gone already: the next create attempt wins or loses on its own
    }
  }
  if (now - holder.at > (opts.staleMs ?? 2 * 60 * 60_000)) return true;
  if (holder.host !== hostname()) return false;
  // our own pid on a lock we do not hold: left by an earlier process that had the same pid (a restarted container)
  if (holder.pid === process.pid) return !heldTokens.has(holder.token);
  return !(opts.isAlive ?? pidAlive)(holder.pid);
}

/** What identifies the lock judged stale: its holder's token, or for an unreadable file its inode, mtime and size. */
type Judged = { token: string } | { ino: number; mtimeMs: number; size: number };

async function judgedIdentity(path: string, holder: InstallLockHolder | null): Promise<Judged | null> {
  if (holder) return { token: holder.token };
  const st = await stat(path).catch(() => null);
  return st ? { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size } : null;
}

/** A breaker left by a process that died while breaking is cleared after this long (breaking takes milliseconds). */
const BREAKER_STALE_MS = 60_000;

/**
 * Remove the stale lock, but only the very one judged stale. Breaking is serialized by a second exclusive file
 * (`<lock>.break`): only its holder may remove the lock, after checking under it that the lock is still the one judged
 * stale. A new lock can only be created once the lock file is gone, and only its owner or the breaker removes a lock,
 * so a waiter that judged an older lock stale can no longer delete a newer live one. Returns without breaking when
 * another waiter holds the breaker (the caller polls again).
 */
async function takeOver(path: string, judged: Judged, now: () => number): Promise<void> {
  const breaker = `${path}.break`;
  const me: InstallLockHolder = { pid: process.pid, host: hostname(), at: now(), token: randomUUID() };
  if (!(await tryCreate(breaker, me))) {
    const st = await stat(breaker).catch(() => null);
    if (st && now() - st.mtimeMs > BREAKER_STALE_MS) {
      // remove only the very breaker judged stale (not a fresh one another waiter just made)
      const first = await readHolder(breaker);
      const again = await stat(breaker).catch(() => null);
      const same = again && again.ino === st.ino && again.mtimeMs === st.mtimeMs && (await readHolder(breaker))?.token === first?.token;
      if (same) await rm(breaker, { force: true }).catch(() => undefined);
    }
    return;
  }
  try {
    const st = await stat(path).catch(() => null);
    if (!st) return; // released or broken already
    const holder = await readHolder(path);
    const same =
      "token" in judged
        ? holder?.token === judged.token
        : !holder && st.ino === judged.ino && st.mtimeMs === judged.mtimeMs && st.size === judged.size;
    if (same) await rm(path, { force: true });
  } finally {
    const mine = await readHolder(breaker);
    if (mine?.token === me.token) await rm(breaker, { force: true }).catch(() => undefined);
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("Installation cancelled.");
}

/** Wait `ms`, or reject when `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Hold the lock at `path` while `run` runs; released in `finally` (only if it is still ours). */
export async function withInstallLock<T>(path: string, run: () => Promise<T>, opts: InstallLockOptions = {}): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const now = opts.now ?? Date.now;
  const mine: InstallLockHolder = { pid: process.pid, host: hostname(), at: now(), token: randomUUID() };
  const deadline = now() + (opts.waitMs ?? 100 * 60_000);
  let announced = false;
  for (;;) {
    opts.signal?.throwIfAborted();
    mine.at = now();
    // known as held before the file exists, so a waiter in this process never mistakes it for a leftover
    heldTokens.add(mine.token);
    if (await tryCreate(path, mine)) break;
    heldTokens.delete(mine.token);
    const holder = await readHolder(path);
    if (await isStale(path, holder, opts)) {
      const judged = await judgedIdentity(path, holder);
      if (judged) await takeOver(path, judged, now);
      // breaking is someone else's right now, or it is done: poll briefly before trying to create again
      await pause(Math.min(opts.pollMs ?? 500, 50), opts.signal);
      continue;
    }
    if (!announced) {
      announced = true;
      opts.onWait?.(holder);
    }
    if (now() >= deadline)
      throw new Error(
        `another fabdesk process${holder ? ` (pid ${holder.pid}${holder.host && holder.host !== hostname() ? ` on ${holder.host}` : ""})` : ""} is still installing; gave up waiting. If no install is running, delete ${path} and Retry.`,
      );
    await pause(opts.pollMs ?? 500, opts.signal);
  }
  try {
    return await run();
  } finally {
    const current = await readHolder(path);
    if (current?.token === mine.token) await rm(path, { force: true }).catch(() => undefined);
    // only once the file is gone: until then a waiter here must still see it as this process's live lock
    heldTokens.delete(mine.token);
  }
}
