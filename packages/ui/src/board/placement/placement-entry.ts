import { useUiStore } from "../../stores/ui";

/** One-shot navigation intent from saved-PCB tools; no source edit or draft mutation. */
type Entry = { projectId: string; sourceId?: string; sourceSha256?: string; ref?: string; tool: "resize" | "compare" };
let requested: Entry | null = null;
export function openPlacementDraft(entry: Entry) {
  if (useUiStore.getState().activeProjectId !== entry.projectId) return;
  requested = entry;
  useUiStore.getState().setBoardTab("placement");
}
export function takePlacementEntry(projectId: string, sourceId?: string): Entry | null {
  if (!requested || requested.projectId !== projectId || requested.sourceId !== sourceId) return null;
  const entry = requested;
  requested = null;
  return entry;
}
