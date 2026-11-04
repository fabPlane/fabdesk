import type { AssemblySceneSelection } from "./assembly-scene";
import type { WorkspaceArea } from "./workspace-navigation";

/** Session-only navigation. Returning never replays edits, checks or other actions. */
export interface WorkspaceHistoryEntry {
  projectId: string;
  area: WorkspaceArea;
  tab: string;
  boardOpen: boolean;
  openSourceId: string | null;
  inventoryOpen: boolean;
  orderFlowOpen: boolean;
  board: AssemblySceneSelection | null;
  filePath: string | null;
}

export function sameWorkspaceLocation(a: WorkspaceHistoryEntry, b: WorkspaceHistoryEntry): boolean {
  // Remember file selection as return context, without turning every file click into a page.
  return a.projectId === b.projectId && a.area === b.area && a.tab === b.tab && a.boardOpen === b.boardOpen && a.openSourceId === b.openSourceId && a.inventoryOpen === b.inventoryOpen && a.orderFlowOpen === b.orderFlowOpen && (a.area !== "boards" || JSON.stringify(a.board) === JSON.stringify(b.board));
}
export function recordWorkspaceHistory(history: WorkspaceHistoryEntry[], before: WorkspaceHistoryEntry | null, after: WorkspaceHistoryEntry | null, coalesced = false): WorkspaceHistoryEntry[] {
  if (!before || !after || before.projectId !== after.projectId) return [];
  if (coalesced || sameWorkspaceLocation(before, after)) return history;
  return [...history, before].slice(-40);
}
