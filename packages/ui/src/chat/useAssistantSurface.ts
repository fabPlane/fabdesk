import { useEffect, useId } from "react";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import type { AssistantSurface } from "./assistant-context";

/** Register only a mounted page/preview. Closing it restores the underlying page context. */
export function useAssistantSurface(surface: AssistantSurface | null) {
  const id = useId(), serialized = surface ? JSON.stringify(surface) : null;
  useEffect(() => {
    const store = useUiStore.getState();
    if (serialized) store.setAssistantSurface(id, JSON.parse(serialized) as AssistantSurface);
    return () => useUiStore.getState().setAssistantSurface(id, null);
  }, [id, serialized]);
}

/** Prepare an unsent question with explicit snapshot context before closing a preview. */
export function askAboutSurface(surface: AssistantSurface, question: string) {
  const ui = useUiStore.getState();
  if (ui.activeProjectId !== surface.projectId) return;
  // Use the store's canonical draft key rather than overwriting an unrelated chat draft.
  const draftKey = ui.activeThreadId ?? newChatDraftKey(surface.projectId);
  const previous = ui.drafts[draftKey]?.trim();
  const instruction = surface.details.slice(0, 6000), label = surface.label.slice(0, 160);
  ui.setDraft(draftKey, previous ? previous.split("\n\n").at(-1) === question ? previous : `${previous}\n\n${question}` : question);
  // Keep questions about different files, boards or findings attached together. An identical
  // captured surface replaces itself; a later page request must not erase earlier evidence.
  ui.setDraftBoardContext(draftKey, { projectId: surface.projectId, sourceKey: JSON.stringify(["requested-ui-surface", label, instruction]), label, instruction });
  ui.setAssistantOpen(true); ui.focusComposer();
}
