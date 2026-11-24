import { schematicFocusScope, recordWorkspaceHistory, sameWorkspaceLocation, type WorkspaceHistoryEntry } from "@fabdesk/client-core";
import type { AssistantSurface } from "../chat/assistant-context";
import type { BoardSourceSelection, SchematicFocus, ProjectBoardSources } from "@fabdesk/protocol";
import type { ProjectBomLine } from "@fabdesk/protocol";
import { create } from "zustand";
import { DRAFT_KEY_NEW, newChatDraftKey, parseAssemblyMapPosition, type AssemblyMapPosition, type AssemblyMapLayout, workspaceAreaForView, workspaceViews, workspaceTabForArea, type WorkspaceArea, type AssemblySceneSelection, type AssemblyCheckFinding, type RootCheckFinding, type KeptOutputChoice } from "@fabdesk/client-core";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { readStoredThemeId, type ThemeId } from "../theme/resolve";
import { stencilThicknessMm } from "./stencil-thickness";

export { DRAFT_KEY_NEW, newChatDraftKey } from "@fabdesk/client-core";

export const BOARD_TABS = ["schematic", "pcb", "cinema", "3d", "cad", "drc", "renders", "files", "bom", "art", "notes", "diff", "comments", "updates", "placement", "layers"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];
export const BOARD_TAB_LABELS: Record<BoardTab, string> = {
  schematic: "Schematic",
  pcb: "2D",
  layers: "Layers",
  placement: "Placement",
  cinema: "Route Cinema",
  "3d": "3D",
  cad: "CAD",
  drc: "DRC/ERC",
  renders: "Renders",
  notes: "Notes",
  files: "Files",
  art: "Art",
  bom: "Shopping list",
  diff: "Diff",
  comments: "Comments",
  updates: "Updates",
};

export const SETTINGS_SECTIONS = ["agents", "kicad", "router", "auth", "remote", "voice", "appearance", "language", "privacy", "shortcuts"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SIDEBAR_LIST_TABS = ["projects", "open_source"] as const;
export type SidebarListTab = (typeof SIDEBAR_LIST_TABS)[number];
export const SIDEBAR_LIST_TAB_LABELS: Record<SidebarListTab, string> = {
  projects: "Projects",
  open_source: "Open source",
};

/** Map a persisted or unknown tab id onto the current set (Conversations and Inventory were removed). */
export function normalizeSidebarListTab(tab: string | undefined | null): SidebarListTab {
  return tab === "open_source" ? tab : "projects";
}

export interface PendingAttachment {
  path: string;
  mime: string;
  label: string;
}

export interface PartsViewState {
  query: string;
  kinds: ProjectBomLine["kind"][];
  buildQuantity: string;
  sourcesOpen: boolean;
  filtersOpen: boolean;
  scrollTop: number;
  scrollLeft: number;
}
export const DEFAULT_PARTS_VIEW: PartsViewState = { query: "", kinds: [], buildQuantity: "5", sourcesOpen: false, filtersOpen: false, scrollTop: 0, scrollLeft: 0 };

export interface UiState {
  partsViewByProject: Record<string, PartsViewState>;
  rememberPartsView: (key: string, patch: Partial<PartsViewState>) => void;
  navigationHistory: WorkspaceHistoryEntry[];
  navigationEndpoint: string | null;
  setNavigationEndpoint: (endpoint: string) => void;
  navigateBack: () => void;
  selectedFileByProject: Record<string, string>;
  rememberProjectFile: (projectId: string, path: string) => void;
  /** Theme chosen in Settings → Appearance; null = derive from the core setting / OS. */
  themeId: ThemeId | null;
  setThemeId: (id: UiState["themeId"]) => void;
  canvasMode: boolean;
  setCanvasMode: (enabled: boolean) => void;
  canvasNavigationOpen: boolean;
  setCanvasNavigationOpen: (open: boolean) => void;
  /** Part link to open when Connections next mounts, such as from a History impact. */
  partLinkFocus: { projectId: string; linkId: string } | null;
  setPartLinkFocus: (focus: { projectId: string; linkId: string } | null) => void;
  /** Last board viewed in History and Connections, per project. */
  boardWorkspacePaths: Record<string, string>;
  setBoardWorkspacePath: (projectId: string, path: string) => void;
  keptOutputChoices: Record<string, KeptOutputChoice>;
  setKeptOutputChoice: (key: string, choice: KeptOutputChoice | null) => void;
  assistantSurfaces: Record<string, AssistantSurface>;
  setAssistantSurface: (id: string, surface: AssistantSurface | null) => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  workspaceArea: WorkspaceArea;
  workspaceByProject: Record<string, { area: WorkspaceArea; tab: BoardTab }>;
  workspaceTabsByProject: Record<string, Partial<Record<WorkspaceArea, BoardTab>>>;
  assemblyBoardByProject: Record<string, AssemblySceneSelection>;
  assemblyMapLayouts: Record<string, AssemblyMapLayout>;
  setAssemblyMapPosition: (key: string, projectId: string, instanceId: string, position: AssemblyMapPosition) => void;
  resetAssemblyMapLayout: (key: string, projectId: string) => void;
  setAssemblyBoard: (selection: AssemblySceneSelection | null) => void;
  schematicPageBySource: Record<string, string>;
  setSchematicPage: (key: string, path: string | null) => void;
  schematicFocusSeen: Record<string, number>;
  schematicFocus: { focus: SchematicFocus; endpoint: string; returnTo: WorkspaceHistoryEntry | null } | null;
  requestSchematicFocus: (focus: SchematicFocus, endpoint: string, sources?: ProjectBoardSources) => void;
  clearSchematicFocus: () => void;
  rootFinding: RootCheckFinding | null;
  openRootFinding: (finding: RootCheckFinding) => void;
  dismissRootFinding: () => void;
  assemblyFinding: AssemblyCheckFinding | null;
  openAssemblyFinding: (finding: AssemblyCheckFinding) => void;
  dismissAssemblyFinding: () => void;
  boardComparisonByProject: Record<string, boolean>;
  setBoardComparison: (enabled: boolean) => void;
  setWorkspaceArea: (area: WorkspaceArea) => void;
  setWorkspaceTab: (tab: BoardTab) => void;
  sidebarOpen: boolean;
  boardOpen: boolean;
  activeThreadId: string | null;
  focusMessageId: string | null;
  activeProjectId: string | null;
  /** Local sidebar preference, retained across app restarts. */
  pinnedProjectIds: string[];
  /** Recently opened projects per connected core; unrelated hosts never share the menu. */
  recentProjectsByEndpoint: Record<string, string[]>;
  recordProjectVisit: (endpoint: string, projectId: string) => void;
  setProjectPinned: (id: string, pinned: boolean) => void;
  sidebarListTab: SidebarListTab;
  activeOpenSourceId: string | null;
  projectPickerOpen: boolean;
  orderFlowOpen: boolean;
  /** Parts Inventory (opened from the user menu) replaces the chat pane while true. */
  inventoryOpen: boolean;
  boardTab: BoardTab;
  commentToReveal: { projectId: string; id: string; view: "pcb" | "schematic"; board?: BoardSourceSelection } | null;
  openBoardComment: (id: string, view: "pcb" | "schematic", board?: BoardSourceSelection) => void;
  fileToReveal: { projectId: string; path: string } | null;
  openProjectFile: (path: string) => void;
  stencilThicknessByProject: Record<string, number>;
  setStencilThickness: (projectId: string, thicknessMm: number) => void;
  drafts: Record<string, string>;
  draftBoardContexts: Record<string, { projectId: string; sourceKey: string; label: string; instruction: string }[]>;
  setDraftBoardContext: (key: string, context: { projectId: string; sourceKey: string; label: string; instruction: string } | null) => void;
  /** Unsaved project notes stay available during navigation in this app session. */
  notesDrafts: Record<string, { base: string; content: string }>;
  setNotesDraft: (key: string, draft: { base: string; content: string } | null) => void;
  attachments: Record<string, PendingAttachment[]>;
  paletteOpen: boolean;
  profileOpen: boolean;
  profileReason: "invitation" | "sharing" | "expired" | null;
  setProfileOpen: (open: boolean, reason?: "invitation" | "sharing" | "expired") => void;
  settingsOpen: boolean;
  /** Section the settings dialog should show when it next opens; null keeps the last one. */
  settingsSection: SettingsSection | null;
  sketchOpen: boolean;
  sketchMode: "draw" | "upload";
  /** Requested saved copy, consumed by the project-scoped sketch session; never persisted. */
  sketchSourcePath: string | null;
  /** Adopt a newly saved sketch project only while the original blank chat is active. */
  adoptSketchProject: (projectId: string) => void;
  agentPickerOpen: boolean;
  whatsNewOpen: boolean;
  /** Id of the release notes the user last read (set on close); the top-bar link hides once it matches. */
  whatsNewSeenId: string | null;
  /** Bumps to request focus on the composer. */
  composerFocusNonce: number;
  toggleSidebar: () => void;
  toggleBoard: () => void;
  setSidebarOpen: (open: boolean) => void;
  setBoardOpen: (open: boolean) => void;
  setActiveThread: (id: string | null) => void;
  setFocusMessageId: (id: string | null) => void;
  /** A different project can only be opened after explicitly returning to Home. */
  setActiveProject: (id: string | null) => boolean;
  projectExitRequested: boolean;
  requestProjectClose: (open: boolean) => void;
  closeProject: () => boolean;
  projectExitBlocks: Record<string, { projectId: string; message: string }>;
  setProjectExitBlock: (key: string, block: { projectId: string; message: string } | null) => void;
  /** Start a blank conversation; a missing project opens the picker. */
  startNewChatInProject: (projectId: string | null) => void;
  setSidebarListTab: (tab: SidebarListTab) => void;
  setActiveOpenSourceId: (id: string | null) => void;
  setProjectPickerOpen: (open: boolean) => void;
  setOrderFlowOpen: (open: boolean) => void;
  setInventoryOpen: (open: boolean) => void;
  setBoardTab: (tab: BoardTab) => void;
  setDraft: (threadKey: string, text: string) => void;
  addAttachment: (threadKey: string, att: PendingAttachment) => void;
  removeAttachment: (threadKey: string, path: string) => void;
  clearAttachments: (threadKey: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean, section?: SettingsSection) => void;
  setSketchOpen: (open: boolean, mode?: "draw" | "upload", sourcePath?: string) => void;
  setAgentPickerOpen: (open: boolean) => void;
  setWhatsNewOpen: (open: boolean) => void;
  markWhatsNewSeen: (id: string) => void;
  focusComposer: () => void;
}

/** Shared patch for “new chat in this project” (sidebar + and the picker). */
export function newChatInProjectState(projectId: string | null) {
  return {
    activeProjectId: projectId,
    activeThreadId: null,
    activeOpenSourceId: null,
    orderFlowOpen: false,
    inventoryOpen: false,
    projectPickerOpen: !projectId,
    sidebarListTab: "projects" as const,
  };
}

function projectNavigationState(s: UiState, activeProjectId: string | null): Partial<UiState> {
  return { activeProjectId, activeThreadId: null, schematicFocus: null, rootFinding: null, assemblyFinding: null, commentToReveal: null, fileToReveal: null,
    activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false, projectPickerOpen: false,
    ...(s.canvasMode ? { boardOpen: true, assistantOpen: false, canvasNavigationOpen: false } : {}),
    workspaceArea: activeProjectId ? s.workspaceByProject[activeProjectId]?.area ?? "boards" : "boards",
    boardTab: activeProjectId ? s.workspaceByProject[activeProjectId]?.tab ?? "pcb" : "pcb" };
}

/** Keep explicit destinations authoritative while remembering each project's other task tabs. */
function workspaceNavigationState(state: UiState, area: WorkspaceArea, tab: BoardTab): Partial<UiState> {
  if (!state.activeProjectId) return { workspaceArea: area, boardTab: tab, boardOpen: true };
  const id = state.activeProjectId, history = state.workspaceTabsByProject ?? {};
  const tabs = { ...history[id] };
  if (workspaceViews(state.workspaceArea).some(view => view.tab === state.boardTab)) tabs[state.workspaceArea] = state.boardTab;
  if (workspaceViews(area).some(view => view.tab === tab)) tabs[area] = tab;
  return { workspaceArea: area, boardTab: tab, boardOpen: true,
    workspaceByProject: { ...state.workspaceByProject, [id]: { area, tab } },
    workspaceTabsByProject: { ...history, [id]: tabs } };
}

function historyLocation(s: UiState): WorkspaceHistoryEntry | null {
  if (!s.activeProjectId) return null;
  return { projectId: s.activeProjectId, area: s.workspaceArea, tab: s.boardTab, boardOpen: s.boardOpen, openSourceId: s.activeOpenSourceId, inventoryOpen: s.inventoryOpen, orderFlowOpen: s.orderFlowOpen,
    board: s.assemblyBoardByProject[s.activeProjectId] ?? null, filePath: s.selectedFileByProject[s.activeProjectId] ?? null };
}

export function createUiStore(storage?: StateStorage) {
  return create<UiState>()(
  persist(
    (rawSet) => {
      let navigationBatch = false;
      const set = (update: Partial<UiState> | ((state: UiState) => Partial<UiState>)) => rawSet(state => {
        const patch = typeof update === "function" ? update(state) : update;
        if ("navigationHistory" in patch) return patch;
        const before = historyLocation(state), after = historyLocation({ ...state, ...patch });
        if (state.schematicFocus && !("schematicFocus" in patch) && before && after && !sameWorkspaceLocation(before, after)) patch.schematicFocus = null;
        const history = recordWorkspaceHistory(state.navigationHistory, before, after, navigationBatch);
        if (before && after && !sameWorkspaceLocation(before, after)) {
          navigationBatch = true; queueMicrotask(() => { navigationBatch = false; });
        }
        return history === state.navigationHistory ? patch : { ...patch, navigationHistory: history };
      });
      return ({
  partsViewByProject: {},
  rememberPartsView: (key, patch) => set(s => ({ partsViewByProject: Object.fromEntries(Object.entries({ ...s.partsViewByProject, [key]: { ...DEFAULT_PARTS_VIEW, ...s.partsViewByProject[key], ...patch } }).slice(-64)) })),
  navigationHistory: [],
  navigationEndpoint: null,
  setNavigationEndpoint: (navigationEndpoint) => set(s => navigationEndpoint === s.navigationEndpoint ? {} : { navigationEndpoint, navigationHistory: [], selectedFileByProject: {}, schematicFocus: null }),
  selectedFileByProject: {},
  rememberProjectFile: (projectId, path) => set(s => s.activeProjectId !== projectId || s.selectedFileByProject[projectId] === path ? {} : { selectedFileByProject: { ...s.selectedFileByProject, [projectId]: path } }),
  navigateBack: () => set(s => {
    const previous = s.navigationHistory.at(-1);
    if (!previous || previous.projectId !== s.activeProjectId) return { navigationHistory: [] };
    const tab = (BOARD_TABS as readonly string[]).includes(previous.tab) ? previous.tab as BoardTab : "pcb";
    const assemblyBoardByProject = { ...s.assemblyBoardByProject };
    if (previous.board) assemblyBoardByProject[previous.projectId] = { ...previous.board }; else delete assemblyBoardByProject[previous.projectId];
    return { ...workspaceNavigationState(s, previous.area, tab), boardOpen: previous.boardOpen,
      activeOpenSourceId: previous.openSourceId, inventoryOpen: previous.inventoryOpen, orderFlowOpen: previous.orderFlowOpen,
      assemblyBoardByProject, fileToReveal: previous.area === "files" && previous.filePath ? { projectId: previous.projectId, path: previous.filePath } : null,
      navigationHistory: s.navigationHistory.slice(0, -1), canvasNavigationOpen: false };
  }),
  // Seed from localStorage so the first React render matches the pre-paint boot script.
  themeId: readStoredThemeId(),
  setThemeId: (themeId) => set({ themeId }),
  canvasMode: true,
  setCanvasMode: (canvasMode) => set({ canvasMode, canvasNavigationOpen: false }),
  canvasNavigationOpen: false,
  setCanvasNavigationOpen: (canvasNavigationOpen) => set({ canvasNavigationOpen }),
  partLinkFocus: null,
  setPartLinkFocus: (partLinkFocus) => set({ partLinkFocus }),
  boardWorkspacePaths: {},
  setBoardWorkspacePath: (projectId, path) => set(s => ({ boardWorkspacePaths: { ...s.boardWorkspacePaths, [projectId]: path } })),
  keptOutputChoices: {},
  setKeptOutputChoice: (key, choice) => set(s => {
    const keptOutputChoices = { ...s.keptOutputChoices };
    if (choice) keptOutputChoices[key] = { ...choice };
    else delete keptOutputChoices[key];
    return { keptOutputChoices };
  }),
  assistantSurfaces: {},
  setAssistantSurface: (id, surface) => set(state => { const assistantSurfaces = { ...state.assistantSurfaces }; if (surface) assistantSurfaces[id] = surface; else delete assistantSurfaces[id]; return { assistantSurfaces }; }),
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  workspaceArea: "boards",
  workspaceByProject: {},
  workspaceTabsByProject: {},
  assemblyMapLayouts: {},
  setAssemblyMapPosition: (key, projectId, instanceId, position) => set(s => {
    const parsed = parseAssemblyMapPosition(position);
    if (s.activeProjectId !== projectId || !instanceId || !parsed) return {};
    return { assemblyMapLayouts: { ...s.assemblyMapLayouts, [key]: { ...s.assemblyMapLayouts?.[key], [instanceId]: parsed } } };
  }),
  resetAssemblyMapLayout: (key, projectId) => set(s => {
    if (s.activeProjectId !== projectId) return {};
    const assemblyMapLayouts = { ...s.assemblyMapLayouts }; delete assemblyMapLayouts[key];
    return { assemblyMapLayouts };
  }),
  assemblyBoardByProject: {},
  setAssemblyBoard: (selection) => set(s => {
    if (!s.activeProjectId || selection && selection.projectId !== s.activeProjectId) return {};
    const assemblyBoardByProject = { ...s.assemblyBoardByProject };
    if (selection) assemblyBoardByProject[s.activeProjectId] = { ...selection };
    else delete assemblyBoardByProject[s.activeProjectId];
    return { assemblyBoardByProject, assemblyFinding: null };
  }),
  schematicPageBySource: {},
  setSchematicPage: (key, path) => set(s => {
    const next = { ...s.schematicPageBySource }; delete next[key];
    if (path) next[key] = path;
    return { schematicPageBySource: Object.fromEntries(Object.entries(next).slice(-64)) };
  }),
  schematicFocusSeen: {},
  schematicFocus: null,
  requestSchematicFocus: (focus, endpoint, sources) => set(s => {
    // Consume even ignored requests, so a reconnect cannot replay them after opening another view.
    const key = `${endpoint}/${focus.id}`;
    if (s.schematicFocusSeen[key]) return {};
    const schematicFocusSeen = Object.fromEntries(Object.entries(s.schematicFocusSeen).filter(([, ts]) => Date.now() - ts < 60_000));
    schematicFocusSeen[key] = focus.requestedAt;
    if (s.navigationEndpoint !== null && s.navigationEndpoint !== endpoint || focus.projectId !== s.activeProjectId || Date.now() - focus.requestedAt > 30_000 || focus.requestedAt > Date.now() + 5_000 || s.settingsOpen || s.sketchOpen || s.inventoryOpen || s.orderFlowOpen || s.activeOpenSourceId || Object.values(s.projectExitBlocks).some(block => block.projectId === focus.projectId)) return { schematicFocusSeen };
    const scope = sources ? schematicFocusScope(focus, sources, s.assemblyBoardByProject[focus.projectId]) : focus.board ? null : { board: null };
    if (!scope) return { schematicFocusSeen };
    const assemblyBoardByProject = { ...s.assemblyBoardByProject };
    if (scope.board) assemblyBoardByProject[focus.projectId] = scope.board;
    return { schematicFocusSeen, assemblyBoardByProject, schematicFocus: { returnTo: s.schematicFocus?.returnTo ?? historyLocation(s), focus: { ...focus, page: { ...focus.page }, points: focus.points.map(point => ({ ...point })) }, endpoint }, workspaceArea: "boards", boardTab: "schematic", boardOpen: true, rootFinding: null, assemblyFinding: null,
      workspaceByProject: { ...s.workspaceByProject, [focus.projectId]: { area: "boards", tab: "schematic" } } };
  }),
  clearSchematicFocus: () => set(s => {
    const previous = s.schematicFocus?.returnTo;
    if (!previous || previous.projectId !== s.activeProjectId || s.workspaceArea !== "boards" || s.boardTab !== "schematic") return { schematicFocus: null };
    const assemblyBoardByProject = { ...s.assemblyBoardByProject };
    if (previous.board) assemblyBoardByProject[previous.projectId] = previous.board; else delete assemblyBoardByProject[previous.projectId];
    return { ...workspaceNavigationState(s, previous.area, previous.tab as BoardTab), boardOpen: previous.boardOpen, assemblyBoardByProject, schematicFocus: null };
  }),
  rootFinding: null,
  openRootFinding: (finding) => set(s => finding.projectId === s.activeProjectId ? {
    rootFinding: { ...finding, point: { ...finding.point } }, assemblyFinding: null,
    workspaceArea: "boards", boardTab: "pcb", boardOpen: true, activeOpenSourceId: null, inventoryOpen: false, orderFlowOpen: false,
    workspaceByProject: { ...s.workspaceByProject, [finding.projectId]: { area: "boards", tab: "pcb" } },
  } : {}),
  dismissRootFinding: () => set({ rootFinding: null }),
  assemblyFinding: null,
  openAssemblyFinding: (finding) => set(s => finding.selection.projectId === s.activeProjectId ? {
    assemblyFinding: { ...finding, selection: { ...finding.selection }, point: { ...finding.point } },
    assemblyBoardByProject: { ...s.assemblyBoardByProject, [finding.selection.projectId]: { ...finding.selection } },
    workspaceArea: "boards", boardTab: "pcb", boardOpen: true, activeOpenSourceId: null, inventoryOpen: false, orderFlowOpen: false,
    workspaceByProject: { ...s.workspaceByProject, [finding.selection.projectId]: { area: "boards", tab: "pcb" } },
  } : {}),
  dismissAssemblyFinding: () => set({ assemblyFinding: null }),
  boardComparisonByProject: {},
  setBoardComparison: (enabled) => set(s => s.activeProjectId ? { boardComparisonByProject: { ...s.boardComparisonByProject, [s.activeProjectId]: enabled } } : {}),
  setWorkspaceArea: (workspaceArea) => set((s) => {
    const remembered = workspaceArea === s.workspaceArea ? s.boardTab : s.activeProjectId ? s.workspaceTabsByProject?.[s.activeProjectId]?.[workspaceArea] : undefined;
    const boardTab = workspaceTabForArea(workspaceArea, remembered) ?? s.boardTab;
    return { ...workspaceNavigationState(s, workspaceArea, boardTab), activeOpenSourceId: null, inventoryOpen: false, orderFlowOpen: false };
  }),
  setWorkspaceTab: (boardTab) => set((s) => workspaceNavigationState(s, s.workspaceArea, boardTab)),
  sidebarOpen: true,
  boardOpen: true,
  activeThreadId: null,
  focusMessageId: null,
  activeProjectId: null,
  projectExitRequested: false,
  projectExitBlocks: {},
  requestProjectClose: (projectExitRequested) => set({ projectExitRequested }),
  setProjectExitBlock: (key, block) => set(s => {
    const projectExitBlocks = { ...s.projectExitBlocks };
    if (block) projectExitBlocks[key] = block; else delete projectExitBlocks[key];
    return { projectExitBlocks };
  }),
  closeProject: () => {
    let closed = false;
    set(s => {
      if (Object.values(s.projectExitBlocks).some(block => block.projectId === s.activeProjectId)) return { projectExitRequested: true };
      closed = true;
      return { ...projectNavigationState(s, null), projectExitRequested: false, paletteOpen: false };
    });
    return closed;
  },
  pinnedProjectIds: [],
  recentProjectsByEndpoint: {},
  recordProjectVisit: (endpoint, projectId) => set(s => {
    if (!endpoint || !projectId) return {};
    const previous = s.recentProjectsByEndpoint[endpoint] ?? [];
    if (previous[0] === projectId) return {};
    const recentProjectsByEndpoint = { ...s.recentProjectsByEndpoint };
    delete recentProjectsByEndpoint[endpoint];
    recentProjectsByEndpoint[endpoint] = [projectId, ...previous.filter(id => id !== projectId)].slice(0, 20);
    return { recentProjectsByEndpoint: Object.fromEntries(Object.entries(recentProjectsByEndpoint).slice(-20)) };
  }),
  setProjectPinned: (id, pinned) => set((s) => ({
    pinnedProjectIds: pinned ? [...s.pinnedProjectIds.filter((value) => value !== id), id] : s.pinnedProjectIds.filter((value) => value !== id),
  })),
  sidebarListTab: "projects",
  activeOpenSourceId: null,
  projectPickerOpen: false,
  orderFlowOpen: false,
  inventoryOpen: false,
  boardTab: "pcb",
  commentToReveal: null,
  openBoardComment: (id, view, board) => set((s) => s.activeProjectId ? {
    commentToReveal: { projectId: s.activeProjectId, id, view, ...(board ? { board: { ...board } } : {}) }, boardTab: view, workspaceArea: "boards", boardOpen: true,
    activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false,
    workspaceByProject: { ...s.workspaceByProject, [s.activeProjectId]: { area: "boards", tab: view } },
  } : {}),
  fileToReveal: null,
  openProjectFile: (path) => set((s) => s.activeProjectId ? {
    boardTab: "files", boardOpen: true, workspaceArea: "files",
    workspaceByProject: { ...s.workspaceByProject, [s.activeProjectId]: { area: "files", tab: "files" } },
    fileToReveal: { projectId: s.activeProjectId, path },
  } : {}),
  stencilThicknessByProject: {},
  setStencilThickness: (projectId, thicknessMm) => set((s) => ({
    stencilThicknessByProject: { ...s.stencilThicknessByProject, [projectId]: stencilThicknessMm(thicknessMm) },
  })),
  drafts: {},
  draftBoardContexts: {},
  setDraftBoardContext: (key, context) => set(s => {
    const draftBoardContexts = { ...s.draftBoardContexts };
    if (context) draftBoardContexts[key] = [...(s.draftBoardContexts[key] ?? []).filter(row => row.sourceKey !== context.sourceKey), context];
    else delete draftBoardContexts[key];
    return { draftBoardContexts };
  }),
  notesDrafts: {},
  setNotesDraft: (key, draft) => set(s => {
    const notesDrafts = { ...s.notesDrafts };
    if (draft) notesDrafts[key] = draft;
    else delete notesDrafts[key];
    return { notesDrafts };
  }),
  attachments: {},
  paletteOpen: false,
  profileOpen: false,
  profileReason: null,
  setProfileOpen: (profileOpen, reason) => set({ profileOpen, profileReason: profileOpen ? reason ?? null : null }),
  settingsOpen: false,
  settingsSection: null,
  sketchOpen: false,
  sketchMode: "draw",
  sketchSourcePath: null,
  adoptSketchProject: (projectId) => set((s) => {
    if (s.activeProjectId || s.activeThreadId) return {};
    const key = newChatDraftKey(projectId);
    return {
      activeProjectId: projectId,
      projectPickerOpen: false,
      drafts: { ...s.drafts, [key]: s.drafts[DRAFT_KEY_NEW] ?? "", [DRAFT_KEY_NEW]: "" },
      attachments: { ...s.attachments, [key]: [...(s.attachments[key] ?? []), ...(s.attachments[DRAFT_KEY_NEW] ?? [])], [DRAFT_KEY_NEW]: [] },
    };
  }),
  agentPickerOpen: false,
  whatsNewOpen: false,
  whatsNewSeenId: null,
  composerFocusNonce: 0,
  toggleSidebar: () => set((s) => s.canvasMode || !s.activeProjectId && !s.activeThreadId ? { canvasNavigationOpen: !s.canvasNavigationOpen } : { sidebarOpen: !s.sidebarOpen }),
  toggleBoard: () => set((s) => ({ boardOpen: !s.boardOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  setActiveThread: (activeThreadId) => set(s => (s.projectExitRequested && activeThreadId ? {} : { activeThreadId, ...(activeThreadId ? { activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false, assistantOpen: true, ...(s.canvasMode ? { canvasNavigationOpen: false } : {}) } : {}) })),
  setFocusMessageId: (focusMessageId) => set({ focusMessageId }),
  setActiveProject: (activeProjectId) => {
    let opened = false;
    set(s => {
      if (s.activeProjectId && activeProjectId !== s.activeProjectId) return { projectExitRequested: true };
      opened = true;
      return activeProjectId === s.activeProjectId ? {} : projectNavigationState(s, activeProjectId);
    });
    return opened;
  },
  startNewChatInProject: (projectId) =>
    set((s) => (s.activeProjectId && projectId !== s.activeProjectId ? { projectExitRequested: true } : { ...newChatInProjectState(projectId), composerFocusNonce: s.composerFocusNonce + 1, assistantOpen: true, ...(s.canvasMode ? { canvasNavigationOpen: false } : {}),
      ...(projectId !== s.activeProjectId ? { rootFinding: null, assemblyFinding: null, workspaceArea: projectId ? s.workspaceByProject[projectId]?.area ?? "boards" : "boards", boardTab: projectId ? s.workspaceByProject[projectId]?.tab ?? "pcb" : "pcb" } : {}) })),
  setSidebarListTab: (sidebarListTab) => set({ sidebarListTab: normalizeSidebarListTab(sidebarListTab) }),
  setActiveOpenSourceId: (activeOpenSourceId) =>
    set(s => ({
      activeOpenSourceId,
      ...(activeOpenSourceId
        ? { activeThreadId: null, orderFlowOpen: false, inventoryOpen: false, sidebarListTab: "open_source" as const, boardOpen: s.canvasMode, ...(s.canvasMode ? { canvasNavigationOpen: false, assistantOpen: false } : {}) }
        : {}),
    })),
  setProjectPickerOpen: (projectPickerOpen) => set({ projectPickerOpen }),
  setOrderFlowOpen: (orderFlowOpen) => set({ orderFlowOpen, ...(orderFlowOpen ? { activeOpenSourceId: null, inventoryOpen: false } : {}) }),
  setInventoryOpen: (inventoryOpen) =>
    set({ inventoryOpen, ...(inventoryOpen ? { activeOpenSourceId: null, orderFlowOpen: false } : {}) }),
  setBoardTab: (boardTab) => set((s) => {
    const workspaceArea = workspaceAreaForView(boardTab);
    return { ...workspaceNavigationState(s, workspaceArea, boardTab), activeOpenSourceId: null, inventoryOpen: false, orderFlowOpen: false };
  }),
  setDraft: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
  addAttachment: (key, att) =>
    set((s) => ({ attachments: { ...s.attachments, [key]: [...(s.attachments[key] ?? []), att] } })),
  removeAttachment: (key, path) =>
    set((s) => ({
      attachments: { ...s.attachments, [key]: (s.attachments[key] ?? []).filter((a) => a.path !== path) },
    })),
  clearAttachments: (key) => set((s) => ({ attachments: { ...s.attachments, [key]: [] } })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsOpen: (settingsOpen, section) => set(settingsOpen && section === "auth"
    ? { profileOpen: true, profileReason: null }
    : { settingsOpen, settingsSection: settingsOpen ? (section ?? null) : null }),
  setSketchOpen: (sketchOpen, sketchMode = "draw", sourcePath) => set({ sketchOpen, sketchMode, sketchSourcePath: sketchOpen && sketchMode === "draw" ? sourcePath ?? null : null }),
  setAgentPickerOpen: (agentPickerOpen) => set({ agentPickerOpen }),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen }),
  markWhatsNewSeen: (whatsNewSeenId) => set({ whatsNewSeenId }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1, assistantOpen: true })),
});
},
    {
      name: "fabdesk.ui",
      storage: createJSONStorage(() => storage ?? localStorage),
      version: 7,
      migrate: (persisted, _version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...state,
          ...(_version < 7 ? { canvasMode: true, assistantOpen: false, workspaceArea: workspaceAreaForView(String(state.boardTab ?? "pcb")), workspaceByProject: {} } : {}),
          // The old shared new-chat slot belonged to the selected project.
          ...(typeof state.activeProjectId === "string" ? {
            drafts: migrateProjectDraftSlot(state.drafts ?? {}, state.activeProjectId),
            attachments: migrateProjectDraftSlot(state.attachments ?? {}, state.activeProjectId),
          } : {}),
          boardTab: (BOARD_TABS as readonly string[]).includes(String(state.boardTab)) ? state.boardTab : "schematic",
          sidebarListTab: normalizeSidebarListTab(typeof state.sidebarListTab === "string" ? state.sidebarListTab : undefined),
        };
      },
      // Survive full reloads (Vite HMR fallbacks, core reloads) without leaking transient state.
      partialize: (s) => ({
        themeId: s.themeId,
        canvasMode: s.canvasMode,
        assistantOpen: s.assistantOpen,
        keptOutputChoices: s.keptOutputChoices,
        workspaceArea: s.workspaceArea,
        workspaceByProject: s.workspaceByProject,
        workspaceTabsByProject: s.workspaceTabsByProject,
        assemblyBoardByProject: s.assemblyBoardByProject,
        assemblyMapLayouts: s.assemblyMapLayouts,
        boardComparisonByProject: s.boardComparisonByProject,
        sidebarOpen: s.sidebarOpen,
        boardOpen: s.boardOpen,
        activeThreadId: s.activeThreadId,
        activeProjectId: s.activeProjectId,
        pinnedProjectIds: s.pinnedProjectIds,
        recentProjectsByEndpoint: s.recentProjectsByEndpoint,
        sidebarListTab: s.sidebarListTab,
        boardTab: s.boardTab,
        stencilThicknessByProject: s.stencilThicknessByProject,
        drafts: s.drafts,
        draftBoardContexts: s.draftBoardContexts,
        attachments: s.attachments,
        whatsNewSeenId: s.whatsNewSeenId,
      }),
    },
  ),
  );
}

export const useUiStore = createUiStore();

/** Migrate the former shared slot once; existing project drafts take precedence. */
export function migrateProjectDraftSlot(value: unknown, projectId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const slots = value as Record<string, unknown>;
  const key = newChatDraftKey(projectId);
  if (!(DRAFT_KEY_NEW in slots) || key in slots) return slots;
  const { [DRAFT_KEY_NEW]: draft, ...rest } = slots;
  return { ...rest, [key]: draft };
}
