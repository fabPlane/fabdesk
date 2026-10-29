import { workspaceViews, restoreAssemblySelection } from "@fabdesk/client-core";
import type { ProjectBoardSources, WorkspaceContext } from "@fabdesk/protocol";
import type { UiState } from "../stores/ui";

export type AssistantSurface = { projectId: string; label: string; details: string; priority: number };
export const selectAssistantState = (state: UiState) => ({
  activeProjectId: state.activeProjectId, workspaceArea: state.workspaceArea, boardTab: state.boardTab,
  assemblyBoardByProject: state.assemblyBoardByProject, assistantSurfaces: state.assistantSurfaces,
  settingsOpen: state.settingsOpen, settingsSection: state.settingsSection, sketchOpen: state.sketchOpen,
  inventoryOpen: state.inventoryOpen, orderFlowOpen: state.orderFlowOpen, activeOpenSourceId: state.activeOpenSourceId,
  rootFinding: state.rootFinding, assemblyFinding: state.assemblyFinding,
});

/** Capture what is on screen now; remembered selections on other pages aren't current UI context. */
export function captureAssistantContext(state: ReturnType<typeof selectAssistantState>, sources: ProjectBoardSources | undefined, checking: boolean, attached: readonly { label: string; instruction: string }[] = [], now = new Date().toISOString()): WorkspaceContext {
  const projectId = state.activeProjectId;
  const view = workspaceViews(state.workspaceArea).find(view => view.tab === state.boardTab)?.label;
  const page = state.settingsOpen ? `Settings / ${state.settingsSection ?? "General"}` : state.sketchOpen ? "Sketch editor" : state.inventoryOpen ? "Parts inventory" : state.orderFlowOpen ? "Order review" : state.activeOpenSourceId ? "Open source project" : `${state.workspaceArea[0]!.toUpperCase()}${state.workspaceArea.slice(1)}${view ? ` / ${view}` : ""}`;
  const surface = !state.settingsOpen && !state.sketchOpen && !state.inventoryOpen && !state.orderFlowOpen && !state.activeOpenSourceId ? Object.values(state.assistantSurfaces).filter(item => item.projectId === projectId).sort((a, b) => b.priority - a.priority)[0] : undefined;
  const selection = projectId && sources?.projectId === projectId && (state.workspaceArea === "boards" || state.workspaceArea === "review") ? restoreAssemblySelection(sources, state.assemblyBoardByProject[projectId]) : null;
  const row = selection ? sources?.sources.find(row => row.source.id === selection.sourceId) : undefined;
  const finding = state.boardTab === "pcb" && state.workspaceArea === "boards" ? state.assemblyFinding?.selection.projectId === projectId && state.assemblyFinding.selection.sourceId === selection?.sourceId ? state.assemblyFinding : state.rootFinding?.projectId === projectId && sources?.mode === "single" ? state.rootFinding : null : null;
  const details = {
    page,
    ...(surface ? { focusedSurface: { label: surface.label, details: surface.details.slice(0, 6000) } } : {}),
    sourceCheck: checking ? "pending or unavailable" : sources?.mode ?? "unavailable",
    ...(selection ? { board: { sourceId: selection.sourceId, instanceId: selection.instanceId, manifestSha256: selection.manifestSha256, name: row?.source.name, availability: row?.status, pcbSha256: checking ? undefined : row?.pcbSha256 } } : {}),
    ...(finding ? { finding: { description: finding.description.slice(0, 1000), item: finding.itemDescription.slice(0, 1000), pointMm: finding.point, recordedSourceSha256: finding.sourceSha256, locationStatus: "Requested from a saved report; current source and drawing match require verification" } } : {}),
    ...(attached.length ? { explicitlyAttachedContext: attached.slice(0, 20).map(item => ({ label: item.label.slice(0, 160), details: item.instruction.slice(0, Math.max(160, Math.floor(6000 / Math.min(attached.length, 20)))) })), attachedContextCount: attached.length } : {}),
  };
  const encoded = JSON.stringify(details);
  const bounded = encoded.length <= 16000 ? encoded : JSON.stringify({ page, summary: encoded.slice(0, 6000), truncated: true });
  return { projectId, label: (surface?.label ?? page).slice(0, 160), details: bounded, capturedAt: now };
}
