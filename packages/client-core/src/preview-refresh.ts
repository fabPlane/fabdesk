import { CoreHttpError, type CoreClient } from "./CoreClient";
import type { QueryClient } from "@tanstack/react-query";

const artifactKinds: Readonly<Record<string, string>> = {
  "board.glb.revision.json": "model",
  "pcb.svg.revision.json": "pcb",
  "schematic.revision.json": "schematic",
  "board-layers.json": "layers",
};

/** Receipts are published after their artifacts. Refresh the displayed bytes,
 * without invalidating native inputs or restarting an export already in flight. */
export function refreshPreviewArtifacts(queries: QueryClient, projectId: string, paths: readonly string[]) {
  const changed = new Set<string>();
  for (const path of paths) {
    const match = /^(?:(.+)\/)?renders\/([^/]+)$/.exec(path.replaceAll("\\", "/"));
    const kind = match && artifactKinds[match[2]!];
    if (match && kind) changed.add(JSON.stringify([match[1] ?? ".", kind]));
  }
  if (!changed.size) return;
  void queries.invalidateQueries({
    queryKey: ["live-preview", projectId],
    predicate: query => changed.has(JSON.stringify([query.queryKey[3], query.queryKey[6]])),
  }, { cancelRefetch: false });
}

/** A drawing-only write may be the first half of a manual export. Repair a missing
 * file, or retry a failed preview after restoration, without interrupting that writer. */
export function refreshPreviewPresence(queries: QueryClient, scope: readonly string[], kind: string, present: boolean) {
  void queries.invalidateQueries({
    queryKey: ["live-preview", ...scope, kind],
    predicate: query => present ? query.state.status === "error" : query.state.data !== undefined,
  }, { cancelRefetch: false });
}

export class PreviewInTrashError extends Error {}

/** Trash may contain an older version even after the user creates a replacement. */
export async function respectPreviewTrash(client: Pick<CoreClient, "listOutputTrash" | "readFileBlob">, projectId: string, path: string) {
  const trash = await client.listOutputTrash(projectId);
  if (!trash.files.some(file => file.path === path)) return;
  try {
    await client.readFileBlob(projectId, path);
  } catch (error) {
    if (!(error instanceof CoreHttpError && error.status === 404)) throw error;
    const label = path.endsWith(".glb") ? "3D model" : path.endsWith("pcb.svg") ? "PCB drawing" : "Schematic drawing";
    throw new PreviewInTrashError(`${label} is in Trash. Restore it from Outputs.`);
  }
}
