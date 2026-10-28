import { create } from "zustand";
import { persist } from "zustand/middleware";
import { readStoredThemeId, type ThemeId } from "../theme/resolve";
import { stencilThicknessMm } from "./stencil-thickness";

export const BOARD_TABS = ["schematic", "pcb", "cinema", "3d", "cad", "drc", "renders", "files", "bom", "art", "notes", "placement", "diff"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];
export const BOARD_TAB_LABELS: Record<BoardTab, string> = {
  schematic: "Schematic",
  pcb: "PCB",
  placement: "Placement",
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
  fileToReveal: { projectId: string; path: string } | null;
  openProjectFile: (path: string) => void;
  stencilThicknessByProject: Record<string, number>;
  setStencilThickness: (projectId: string, thicknessMm: number) => void;
  drafts: Record<string, string>;
  attachments: Record<string, PendingAttachment[]>;
  paletteOpen: boolean;
  settingsOpen: boolean;
  /** Section the settings dialog should show when it next opens; null keeps the last one. */
  settingsSection: SettingsSection | null;
  sketchOpen: boolean;
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
  setSketchOpen: (open: boolean) => void;
  setAgentPickerOpen: (open: boolean) => void;
  setWhatsNewOpen: (open: boolean) => void;
  markWhatsNewSeen: (id: string) => void;
  focusComposer: () => void;
}

export const DRAFT_KEY_NEW = "__new__";

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

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
  // Seed from localStorage so the first React render matches the pre-paint boot script.
  themeId: readStoredThemeId(),
  setThemeId: (themeId) => set({ themeId }),
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
  boardTab: "schematic",
  fileToReveal: null,
  openProjectFile: (path) => set((s) => s.activeProjectId ? {
    boardTab: "files", boardOpen: true,
    fileToReveal: { projectId: s.activeProjectId, path },
  } : {}),
  stencilThicknessByProject: {},
  setStencilThickness: (projectId, thicknessMm) => set((s) => ({
    stencilThicknessByProject: { ...s.stencilThicknessByProject, [projectId]: stencilThicknessMm(thicknessMm) },
  })),
  drafts: {},
  attachments: {},
  paletteOpen: false,
  settingsOpen: false,
  settingsSection: null,
  sketchOpen: false,
  agentPickerOpen: false,
  whatsNewOpen: false,
  whatsNewSeenId: null,
  composerFocusNonce: 0,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleBoard: () => set((s) => ({ boardOpen: !s.boardOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  setActiveThread: (activeThreadId) => set({ activeThreadId, ...(activeThreadId ? { activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false } : {}) }),
  setFocusMessageId: (focusMessageId) => set({ focusMessageId }),
  setActiveProject: (activeProjectId) => set((s) => ({ activeProjectId, ...(activeProjectId !== s.activeProjectId ? { activeThreadId: null, activeOpenSourceId: null, orderFlowOpen: false, inventoryOpen: false } : {}) })),
  startNewChatInProject: (projectId) =>
    set((s) => ({ ...newChatInProjectState(projectId), composerFocusNonce: s.composerFocusNonce + 1 })),
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
  setBoardTab: (boardTab) => set({ boardTab, boardOpen: true }),
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
  setSketchOpen: (sketchOpen) => set({ sketchOpen }),
  setAgentPickerOpen: (agentPickerOpen) => set({ agentPickerOpen }),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen }),
  markWhatsNewSeen: (whatsNewSeenId) => set({ whatsNewSeenId }),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
}),
    {
      name: "fabdesk.ui",
      version: 5,
      migrate: (persisted, _version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...state,
          boardTab: (BOARD_TABS as readonly string[]).includes(String(state.boardTab)) ? state.boardTab : "schematic",
          sidebarListTab: normalizeSidebarListTab(typeof state.sidebarListTab === "string" ? state.sidebarListTab : undefined),
        };
      },
      // Survive full reloads (Vite HMR fallbacks, core reloads) without leaking transient state.
      partialize: (s) => ({
        themeId: s.themeId,
        sidebarOpen: s.sidebarOpen,
        boardOpen: s.boardOpen,
        activeThreadId: s.activeThreadId,
        activeProjectId: s.activeProjectId,
        pinnedProjectIds: s.pinnedProjectIds,
        sidebarListTab: s.sidebarListTab,
        boardTab: s.boardTab,
        stencilThicknessByProject: s.stencilThicknessByProject,
        drafts: s.drafts,
        whatsNewSeenId: s.whatsNewSeenId,
      }),
    },
  ),
);
