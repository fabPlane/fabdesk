import { useEffect } from "react";
import { useBoardSources } from "@fabdesk/client-core";
import { askAboutSurface } from "../chat/useAssistantSurface";
import { captureAssistantContext, selectAssistantState } from "../chat/assistant-context";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { Dialog } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { DrcTab } from "./DrcTab";

/** The board task keeps its canvas and view; Review / Checks remains the project-wide destination. */
export function BoardChecksDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const sources = useBoardSources(projectId), settingsOpen = useUiStore(state => state.settingsOpen);
  useEffect(() => { if (open && settingsOpen) onClose(); }, [open, settingsOpen, onClose]);
  return <Dialog open={open} onClose={onClose} title="Board checks" className="fd-board-checks-dialog" headerActions={<CanvasToolButton icon="sparkles" label="Ask about these checks" onClick={() => {
      const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return;
      const context = captureAssistantContext(selectAssistantState(ui), sources.data, sources.isFetching || sources.isError);
      askAboutSurface({ projectId, label: context.label, details: context.details, priority: 50 }, "Help me understand this board’s saved check results. Explain the selected finding, what has actually been checked, and the safest next step before changing anything."); onClose();
    }} />}>
    <DrcTab contextual onNavigate={onClose} />
  </Dialog>;
}
