import { create } from "zustand";
import { persist } from "zustand/middleware";

export const BOARD_TABS = ["schematic", "pcb", "cinema", "3d", "drc", "renders", "files"] as const;
export type BoardTab = (typeof BOARD_TABS)[number];
export const BOARD_TAB_LABELS: Record<BoardTab, string> = {
  schematic: "Schematic",
  pcb: "PCB",
  cinema: "Route Cinema",
  "3d": "3D",
  drc: "DRC/ERC",
  renders: "Renders",
  files: "Files",
};

export const SETTINGS_SECTIONS = ["agents", "kicad", "router", "auth", "appearance", "privacy", "shortcuts"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface PendingAttachment {
  path: string;
  mime: string;
  label: string;
}

export interface UiState {
  sidebarOpen: boolean;
  boardOpen: boolean;
  activeThreadId: string | null;
  activeProjectId: string | null;
  boardTab: BoardTab;
  drafts: Record<string, string>;
  attachments: Record<string, PendingAttachment[]>;
  paletteOpen: boolean;
  settingsOpen: boolean;
  /** Section the settings dialog should show when it next opens; null keeps the last one. */
  settingsSection: SettingsSection | null;
  sketchOpen: boolean;
  agentPickerOpen: boolean;
  /** Bumps to request focus on the composer. */
  composerFocusNonce: number;
  toggleSidebar: () => void;
  toggleBoard: () => void;
  setSidebarOpen: (open: boolean) => void;
  setBoardOpen: (open: boolean) => void;
  setActiveThread: (id: string | null) => void;
  setActiveProject: (id: string | null) => void;
  setBoardTab: (tab: BoardTab) => void;
  setDraft: (threadKey: string, text: string) => void;
  addAttachment: (threadKey: string, att: PendingAttachment) => void;
  removeAttachment: (threadKey: string, path: string) => void;
  clearAttachments: (threadKey: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean, section?: SettingsSection) => void;
  setSketchOpen: (open: boolean) => void;
  setAgentPickerOpen: (open: boolean) => void;
  focusComposer: () => void;
}

export const DRAFT_KEY_NEW = "__new__";

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
  sidebarOpen: true,
  boardOpen: true,
  activeThreadId: null,
  activeProjectId: null,
  boardTab: "schematic",
  drafts: {},
  attachments: {},
  paletteOpen: false,
  settingsOpen: false,
  settingsSection: null,
  sketchOpen: false,
  agentPickerOpen: false,
  composerFocusNonce: 0,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleBoard: () => set((s) => ({ boardOpen: !s.boardOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  setActiveThread: (activeThreadId) => set({ activeThreadId }),
  setActiveProject: (activeProjectId) => set({ activeProjectId }),
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
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),
}),
    {
      name: "fabdesk.ui",
      version: 1,
      // Survive full reloads (Vite HMR fallbacks, core reloads) without leaking transient state.
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        boardOpen: s.boardOpen,
        activeThreadId: s.activeThreadId,
        activeProjectId: s.activeProjectId,
        boardTab: s.boardTab,
        drafts: s.drafts,
      }),
    },
  ),
);
