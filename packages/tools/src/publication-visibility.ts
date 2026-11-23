import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { jailPath, writeAtomic, writeJson } from "./fs";

const statePath = ".fabdesk/handoff/visibility.json";
type Entry = { path: string; sha256: string } | null;
type Visibility = { phase: "publishing" | "committed"; files: Record<string, Entry> };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function publicationInProgress(dir: string): Promise<boolean> {
  try { return JSON.parse(await readFile(await jailPath(dir, statePath), "utf8")).phase === "publishing"; } catch { return false; }
}
/** HTTP readers keep seeing the complete previous generation while canonical files are replaced.
 * A committed immutable generation is used only while its canonical bytes still match, so later
 * explicit renders/edits/deletions are never hidden by an earlier publication. */
export async function visiblePublishedFile(dir: string, path: string): Promise<string | null | undefined> {
  let state: Visibility;
  try { state = JSON.parse(await readFile(await jailPath(dir, statePath), "utf8")); } catch { return undefined; }
  if (!state.files || !Object.hasOwn(state.files, path)) return undefined;
  const entry = state.files[path];
  if (state.phase === "publishing") return entry ? jailPath(dir, entry.path) : null;
  if (state.phase !== "committed" || !entry) return undefined;
  const bytes = await readFile(await jailPath(dir, path)).catch(() => null);
  return bytes && hash(bytes) === entry.sha256 ? jailPath(dir, entry.path) : undefined;
}

export async function beginPublicationVisibility(dir: string, outputs: Array<{ path: string; bytes: Uint8Array }>) {
  const previous = new Map<string, Uint8Array | null>();
  const save = async (values: Array<{ path: string; bytes: Uint8Array | null }>) => {
    const generation = `.fabdesk/handoff/generations/${randomUUID()}`;
    const files: Record<string, Entry> = {};
    for (const value of values) {
      if (value.bytes === null) { files[value.path] = null; continue; }
      const path = `${generation}/${value.path}`;
      await writeAtomic(await jailPath(dir, path), value.bytes);
      files[value.path] = { path, sha256: hash(value.bytes) };
    }
    return files;
  };
  for (const output of outputs) {
    const visible = await visiblePublishedFile(dir, output.path);
    previous.set(output.path, visible === null ? null : await readFile(visible ?? await jailPath(dir, output.path)).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; }));
  }
  const oldFiles = await save([...previous].map(([path, bytes]) => ({ path, bytes })));
  const nextFiles = await save(outputs);
  const state = await jailPath(dir, statePath);
  await writeJson(state, { phase: "publishing", files: oldFiles });
  return {
    commit: () => writeJson(state, { phase: "committed", files: nextFiles }),
    rollback: () => writeJson(state, { phase: "committed", files: oldFiles }),
  };
}
