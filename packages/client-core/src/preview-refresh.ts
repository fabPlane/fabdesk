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
