/**
 * A cross-process lock for engine installs. The registry's in-memory `inflight` map only joins installs inside one
 * process; two processes (two standalone `fabdesk mcp`, the desktop daemon and a CLI) installing the same engine
 * would otherwise swap and delete each other's install folders and overwrite each other's state.
 *
 * The lock is a file created exclusively (`wx`, atomic on POSIX and Windows) holding the owner's pid, host, start
 * time and a random token. A waiter polls until it is gone, and takes over a stale one: its pid is dead (same
 * host), or it is older than `staleMs`, or it is an unreadable file that has not changed for a while (a holder that
 * died between create and write). The waiter is bounded by `waitMs` and aborted by `signal`.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export type InstallLockHolder = { pid: number; host: string; at: number; token: string };

export type InstallLockOptions = {
  signal?: AbortSignal;
  /** A lock older than this is taken over even when its pid looks alive (default 2 h; a cold KRT build is minutes). */
  staleMs?: number;
  /** How long to wait for a live holder before giving up (default 45 min). */
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
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
  return holder.host === hostname() && !(opts.isAlive ?? pidAlive)(holder.pid);
}

/**
 * Move a stale lock aside, then check it is the one judged stale: if another waiter already replaced it with its
 * own live lock in between, put that one back (`link` fails if a third lock appeared meanwhile, which then wins).
 */
async function takeOver(path: string, judged: InstallLockHolder | null): Promise<void> {
  const aside = `${path}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(path, aside);
  } catch {
    return; // someone else moved or released it
  }
  const moved = await readHolder(aside);
  if (judged && moved && moved.token !== judged.token) await link(aside, path).catch(() => undefined);
  await rm(aside, { force: true }).catch(() => undefined);
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
  const deadline = now() + (opts.waitMs ?? 45 * 60_000);
  let announced = false;
  for (;;) {
    opts.signal?.throwIfAborted();
    mine.at = now();
    if (await tryCreate(path, mine)) break;
    const holder = await readHolder(path);
    if (await isStale(path, holder, opts)) {
      await takeOver(path, holder);
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
  }
}
