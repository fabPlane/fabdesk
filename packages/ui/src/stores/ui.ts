import { create } from "zustand";
import { DRAFT_KEY_NEW, newChatDraftKey, workspaceAreaForView, workspaceViews, workspaceTabForArea, type WorkspaceArea, type AssemblySceneSelection, type AssemblyCheckFinding, type RootCheckFinding, type KeptOutputChoice } from "@fabdesk/client-core";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { readStoredThemeId, type ThemeId } from "../theme/resolve";
import { stencilThicknessMm } from "./stencil-thickness";

export { DRAFT_KEY_NEW, newChatDraftKey } from "@fabdesk/client-core";

export const BOARD_TABS = ["schematic", "pcb", "cinema", "3d", "cad", "drc", "renders", "files", "bom", "art", "notes", "diff", "comments", "updates"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];
export const BOARD_TAB_LABELS: Record<BoardTab, string> = {
  schematic: "Schematic",
  pcb: "PCB",
  cinema: "Route Cinema",
  "3d": "3D export",
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

export const SETTINGS_SECTIONS = ["agents", "kicad", "router", "auth", "remote", "voice", "appearance", "privacy", "shortcuts"] as const;
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

export interface UiState {
  /** Theme chosen in Settings → Appearance; null = derive from the core setting / OS. */
  themeId: ThemeId | null;
  setThemeId: (id: UiState["themeId"]) => void;
  canvasMode: boolean;
  setCanvasMode: (enabled: boolean) => void;
  canvasNavigationOpen: boolean;
  setCanvasNavigationOpen: (open: boolean) => void;
  keptOutputChoices: Record<string, KeptOutputChoice>;
  setKeptOutputChoice: (key: string, choice: KeptOutputChoice | null) => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  workspaceArea: WorkspaceArea;
  workspaceByProject: Record<string, { area: WorkspaceArea; tab: BoardTab }>;
  workspaceTabsByProject: Record<string, Partial<Record<WorkspaceArea, BoardTab>>>;
  assemblyBoardByProject: Record<string, AssemblySceneSelection>;
  setAssemblyBoard: (selection: AssemblySceneSelection | null) => void;
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
  setProjectPinned: (id: string, pinned: boolean) => void;
  sidebarListTab: SidebarListTab;
  activeOpenSourceId: string | null;
  projectPickerOpen: boolean;
  orderFlowOpen: boolean;
  /** Parts Inventory (opened from the user menu) replaces the chat pane while true. */
  inventoryOpen: boolean;
  boardTab: BoardTab;
  commentToReveal: { projectId: string; id: string; view: "pcb" | "schematic" } | null;
  openBoardComment: (id: string, view: "pcb" | "schematic") => void;
  fileToReveal: { projectId: string; path: string } | null;
  openProjectFile: (path: string) => void;
  stencilThicknessByProject: Record<string, number>;
  setStencilThickness: (projectId: string, thicknessMm: number) => void;
  drafts: Record<string, string>;
  /** Unsaved project notes stay available during navigation in this app session. */
  notesDrafts: Record<string, { base: string; content: string }>;
  setNotesDraft: (key: string, draft: { base: string; content: string } | null) => void;
  attachments: Record<string, PendingAttachment[]>;
  paletteOpen: boolean;
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
  setActiveProject: (id: string | null) => void;
  /** Start a blank conversation in a project (or none). Skips the project picker. */
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
    projectPickerOpen: false,
    sidebarListTab: "projects" as const,
  };
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

export function createUiStore(storage?: StateStorage) {
  return create<UiState>()(
  persist(
    (set) => ({
  // Seed from localStorage so the first React render matches the pre-paint boot script.
  themeId: readStoredThemeId(),
  setThemeId: (themeId) => set({ themeId }),
  canvasMode: true,
  setCanvasMode: (canvasMode) => set({ canvasMode, canvasNavigationOpen: false }),
  canvasNavigationOpen: false,
  setCanvasNavigationOpen: (canvasNavigationOpen) => set({ canvasNavigationOpen }),
  keptOutputChoices: {},
  setKeptOutputChoice: (key, choice) => set(s => {
    const keptOutputChoices = { ...s.keptOutputChoices };
    if (choice) keptOutputChoices[key] = { ...choice };
    else delete keptOutputChoices[key];
    return { keptOutputChoices };
  }),
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  workspaceArea: "boards",
  workspaceByProject: {},
  workspaceTabsByProject: {},
  assemblyBoardByProject: {},
  setAssemblyBoard: (selection) => set(s => {
    if (!s.activeProjectId || selection && selection.projectId !== s.activeProjectId) return {};
    const assemblyBoardByProject = { ...s.assemblyBoardByProject };
    if (selection) assemblyBoardByProject[s.activeProjectId] = { ...selection };
    else delete assemblyBoardByProject[s.activeProjectId];
    return { assemblyBoardByProject, assemblyFinding: null };
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
  pinnedProjectIds: [],
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
  openBoardComment: (id, view) => set((s) => s.activeProjectId ? {
    commentToReveal: { projectId: s.activeProjectId, id, view }, boardTab: view, workspaceArea: "boards", boardOpen: true,
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
  notesDrafts: {},
  setNotesDraft: (key, draft) => set(s => {
    const notesDrafts = { ...s.notesDrafts };
    if (draft) notesDrafts[key] = draft;
    else delete notesDrafts[key];
    return { notesDrafts };
  }),
  attachments: {},
  paletteOpen: false,
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
  toggleSidebar: () => set((s) => s.canvasMode ? { canvasNavigationOpen: !s.canvasNavigationOpen } : { sidebarOpen: !s.sidebarOpen }),
  toggleBoard: () => set((s) => ({ boardOpen: !s.boardOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  setActiveThread: (activeThreadId) => set(s => ({ activeThreadId, ...(activeThreadId ? { activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false, assistantOpen: true, ...(s.canvasMode ? { canvasNavigationOpen: false } : {}) } : {}) })),
  setFocusMessageId: (focusMessageId) => set({ focusMessageId }),
  setActiveProject: (activeProjectId) => set((s) => ({ activeProjectId, ...(activeProjectId !== s.activeProjectId ? { activeThreadId: null, rootFinding: null, assemblyFinding: null, commentToReveal: null, activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false, ...(s.canvasMode ? { boardOpen: true, assistantOpen: false, canvasNavigationOpen: false } : {}), workspaceArea: activeProjectId ? s.workspaceByProject[activeProjectId]?.area ?? "boards" : "boards", boardTab: activeProjectId ? s.workspaceByProject[activeProjectId]?.tab ?? "pcb" : "pcb" } : {}) })),
  startNewChatInProject: (projectId) =>
    set((s) => ({ ...newChatInProjectState(projectId), composerFocusNonce: s.composerFocusNonce + 1, assistantOpen: true, ...(s.canvasMode ? { canvasNavigationOpen: false } : {}),
      ...(projectId !== s.activeProjectId ? { rootFinding: null, assemblyFinding: null, workspaceArea: projectId ? s.workspaceByProject[projectId]?.area ?? "boards" : "boards", boardTab: projectId ? s.workspaceByProject[projectId]?.tab ?? "pcb" : "pcb" } : {}) })),
  setSidebarListTab: (sidebarListTab) => set({ sidebarListTab: normalizeSidebarListTab(sidebarListTab) }),
  setActiveOpenSourceId: (activeOpenSourceId) =>
    set({
      activeOpenSourceId,
      ...(activeOpenSourceId
        ? { activeThreadId: null, orderFlowOpen: false, inventoryOpen: false, sidebarListTab: "open_source" as const, boardOpen: false }
        : {}),
    }),
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
  setSettingsOpen: (settingsOpen, section) => set({ settingsOpen, settingsSection: settingsOpen ? (section ?? null) : null }),
  setSketchOpen: (sketchOpen, sketchMode = "draw", sourcePath) => set({ sketchOpen, sketchMode, sketchSourcePath: sketchOpen && sketchMode === "draw" ? sourcePath ?? null : null }),
  setAgentPickerOpen: (agentPickerOpen) => set({ agentPickerOpen }),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen }),
  markWhatsNewSeen: (whatsNewSeenId) => set({ whatsNewSeenId }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1, assistantOpen: true })),
}),
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
        boardComparisonByProject: s.boardComparisonByProject,
        sidebarOpen: s.sidebarOpen,
        boardOpen: s.boardOpen,
        activeThreadId: s.activeThreadId,
        activeProjectId: s.activeProjectId,
        pinnedProjectIds: s.pinnedProjectIds,
        sidebarListTab: s.sidebarListTab,
        boardTab: s.boardTab,
        stencilThicknessByProject: s.stencilThicknessByProject,
        drafts: s.drafts,
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
