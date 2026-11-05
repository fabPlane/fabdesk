import { sha256Blob } from "./pcb-preview-revision";

// Weak keys retain fingerprints without retaining large binary assets after the query releases them.
const hashes = new WeakMap<Blob, Promise<string>>();
function hash(blob: Blob): Promise<string> {
  const cached = hashes.get(blob);
  if (cached) return cached;
  const pending = sha256Blob(blob);
  hashes.set(blob, pending);
  void pending.catch(() => { if (hashes.get(blob) === pending) hashes.delete(blob); });
  return pending;
}

/** Keep existing file-prefix invalidation while separating endpoints, projects and paths. */
export function projectBlobQueryKey(baseUrl: string, projectId: string | null, path: string | null) {
  return ["file", projectId, path, "blob", baseUrl] as const;
}

/** After a real fetch, reuse only an identical binary snapshot from the same query scope. */
export async function reuseUnchangedProjectBlob(previous: Blob | null | undefined, fresh: Blob | null): Promise<Blob | null> {
  if (!previous || !fresh || previous.type !== fresh.type || previous.size !== fresh.size) return fresh;
  const [before, after] = await Promise.all([hash(previous), hash(fresh)]);
  return before === after ? previous : fresh;
}
