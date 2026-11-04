import type { ProjectBoardSources } from "@fabdesk/protocol";
import { restoreAssemblySelection } from "../assembly-scene";
import type { PlacementSession } from "./types";

/** A draft belongs to an exact source revision, never the first board in a repository. */
export interface PlacementSource {
  projectId: string;
  path: string;
  sha256: string;
  sourceId?: string;
}
export function placementSourceKey(endpoint: string, source: PlacementSource): string {
  return JSON.stringify([endpoint.replace(/\/$/, ""), source.projectId, source.path, source.sha256, source.sourceId ?? null]);
}
export function placementSourceDraftPath(source: PlacementSource): string {
  // Full revision avoids replacing drafts made from an earlier saved PCB.
  return `placement/drafts/${source.sha256}/${encodeURIComponent(source.sourceId ?? "root")}/${source.path}.placement.json`;
}
export function encodePlacementDraft(source: PlacementSource, session: PlacementSession): string {
  return JSON.stringify({ contract: "fabplane.placement-draft.v1", source, session });
}
export function decodePlacementDraft(text: string, expected: PlacementSource): string {
  const draft = JSON.parse(text);
  if (draft?.contract !== "fabplane.placement-draft.v1" ||
      draft.source?.projectId !== expected.projectId || draft.source?.path !== expected.path ||
      draft.source?.sha256 !== expected.sha256 || draft.source?.sourceId !== expected.sourceId || !draft.session)
    throw new Error("This draft belongs to another board or source revision. The saved file is preserved. Open its original board and project to continue.");
  return JSON.stringify(draft.session);
}

/** No first-member fallback: a declared, currently owned selection is required. */
export function placementSourceTarget(data: ProjectBoardSources | undefined, saved: unknown): { path: string; sourceId?: string } | null {
  if (!data) return null;
  if (data.mode === "single") return { path: "board.kicad_pcb" };
  const selected = restoreAssemblySelection(data, saved);
  const row = selected ? data.sources.find(row => row.source.id === selected.sourceId) : undefined;
  return row?.status === "available" && row.source.location === "project" && row.pcbPath ? { path: row.pcbPath, sourceId: row.source.id } : null;
}
