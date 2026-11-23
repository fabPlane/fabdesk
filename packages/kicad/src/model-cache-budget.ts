import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MODEL_CACHE_BUDGET = 256 * 1024 * 1024;
type CacheEntry = { path: string; name: string; bytes: number; used: number };

async function entries(dir: string, pattern: RegExp): Promise<CacheEntry[]> {
  const names = await readdir(dir).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (await Promise.all(names.filter(name => pattern.test(name)).map(async name => {
    const path = join(dir, name);
    const info = await stat(path).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return info?.isFile() ? { path, name, bytes: info.size, used: info.mtimeMs } : null;
  }))).filter((entry): entry is CacheEntry => !!entry);
}

/** Receipts are touched on reuse. Evict a shared object only after its last receipt. */
export async function trimModelCache(root: string, budget = MODEL_CACHE_BUDGET) {
  // Interrupted writes from a previous process can leave unpublished temporaries.
  for (const directory of ["objects", "refs"]) {
    const temporary = await entries(join(root, directory), /^[a-f0-9-]{36}\.tmp$/);
    for (const file of temporary) await rm(file.path, { force: true });
  }
  const [objects, refs] = await Promise.all([
    entries(join(root, "objects"), /^[a-f0-9]{64}\.step$/),
    entries(join(root, "refs"), /^[a-f0-9]{40}-[a-f0-9]{64}\.json$/),
  ]);
  let bytes = [...objects, ...refs].reduce((sum, entry) => sum + entry.bytes, 0);
  if (bytes <= budget) return;
  const byDigest = new Map(objects.map(object => [object.name.slice(0, -5), object]));
  const claims = new Map<string, number>();
  const receipts = [];
  for (const ref of refs.sort((a, b) => a.used - b.used || a.name.localeCompare(b.name))) {
    let digest: string | undefined;
    try { digest = JSON.parse(await readFile(ref.path, "utf8")).sha256; }
    catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (digest && byDigest.has(digest)) {
      claims.set(digest, (claims.get(digest) ?? 0) + 1);
      receipts.push({ ref, digest });
    } else {
      await rm(ref.path, { force: true });
      bytes -= ref.bytes;
    }
  }
  for (const [digest, object] of byDigest) {
    if (claims.has(digest)) continue;
    await rm(object.path, { force: true });
    bytes -= object.bytes;
  }
  for (const { ref, digest } of receipts) {
    if (bytes <= budget) break;
    await rm(ref.path, { force: true });
    bytes -= ref.bytes;
    const remaining = claims.get(digest)! - 1;
    claims.set(digest, remaining);
    if (!remaining) {
      const object = byDigest.get(digest)!;
      await rm(object.path, { force: true });
      bytes -= object.bytes;
    }
  }
}

// Each daemon shares a reader lease across its overlapping jobs. The lease also
// protects files from another FabDesk process using the same per-user cache.
type Lease = { directory: string; name: string };
type CacheState = { users: number; dirty: boolean; lease?: Promise<Lease | null>; maintenance?: Promise<void> };
const caches = new Map<string, CacheState>();
function cacheState(root: string) {
  let state = caches.get(root);
  if (!state) { state = { users: 0, dirty: true }; caches.set(root, state); }
  return state;
}

async function activeLeases(directory: string) {
  const active = [];
  for (const name of await readdir(directory)) {
    const match = /^(read|trim)-(\d+)-[a-f0-9-]+$/.exec(name);
    if (!match) continue;
    try { process.kill(Number(match[2]), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        await rm(join(directory, name), { force: true });
        continue;
      }
    }
    active.push(name);
  }
  return active;
}

async function acquire(root: string): Promise<Lease | null> {
  const directory = join(root, "leases"), name = `read-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), "", { flag: "wx" });
  } catch (error) {
    if (["EACCES", "EROFS", "EPERM", "ENOSPC"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  try {
    while ((await activeLeases(directory)).some(other => other.startsWith("trim-"))) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { directory, name };
  } catch (error) {
    await rm(join(directory, name), { force: true });
    throw error;
  }
}

async function release(root: string, lease: Lease | null, dirty: boolean) {
  if (!lease) return;
  const { directory } = lease, pending = join(directory, "needs-trim");
  let name = lease.name;
  try {
    if (dirty) await writeFile(pending, "");
    else if (!await stat(pending).catch(() => null)) return;
    const trimmer = name.replace(/^read-/, "trim-");
    await rename(join(directory, name), join(directory, trimmer));
    name = trimmer;
    const peers = (await activeLeases(directory)).filter(other => other !== name);
    // An active reader will collect on release. Simultaneous collectors elect one.
    if (peers.some(other => other.startsWith("read-") || other < name)) return;
    await trimModelCache(root);
    await rm(pending, { force: true });
  } finally { await rm(join(directory, name), { force: true }); }
}

export function cacheWriteCompleted(root: string) { cacheState(root).dirty = true; }

export async function withModelCache<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const state = cacheState(root);
  while (state.maintenance) await state.maintenance;
  state.lease ??= acquire(root);
  state.users++;
  try {
    await state.lease;
    return await operation();
  } finally {
    if (--state.users === 0) {
      const dirty = state.dirty;
      state.dirty = false;
      state.maintenance = state.lease.then(lease => release(root, lease, dirty)).catch(error => {
        state.dirty = true;
        console.warn("Could not trim KiCad model cache", error);
      }).finally(() => { delete state.maintenance; });
      delete state.lease;
      await state.maintenance;
    }
  }
}
