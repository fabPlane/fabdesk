import { describe, expect, test } from "bun:test";
import { BOARD_TABS, BOARD_TAB_LABELS, SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, newChatInProjectState, normalizeSidebarListTab, useUiStore } from "./ui";

describe("sidebar list tabs", () => {
  test("exposes Projects and Open source (Parts Inventory lives in the user menu)", () => {
    expect(SIDEBAR_LIST_TABS).toEqual(["projects", "open_source"]);
    expect(Object.keys(SIDEBAR_LIST_TAB_LABELS)).toEqual(["projects", "open_source"]);
    expect(SIDEBAR_LIST_TAB_LABELS.projects).toBe("Projects");
    expect(SIDEBAR_LIST_TAB_LABELS.open_source).toBe("Open source");
  });

  test("new chat in a project clears the thread and picker", () => {
    expect(newChatInProjectState("prj_amp")).toEqual({
      activeProjectId: "prj_amp",
      activeThreadId: null,
      activeOpenSourceId: null,
      orderFlowOpen: false,
      inventoryOpen: false,
      projectPickerOpen: false,
      sidebarListTab: "projects",
    });
    expect(newChatInProjectState(null)).toMatchObject({ activeProjectId: null, projectPickerOpen: true });
  });

  test("normalizes the removed Conversations and Inventory tabs onto Projects", () => {
    expect(normalizeSidebarListTab("conversations")).toBe("projects");
    expect(normalizeSidebarListTab("projects")).toBe("projects");
    expect(normalizeSidebarListTab("open_source")).toBe("open_source");
    expect(normalizeSidebarListTab("inventory")).toBe("projects");
    expect(normalizeSidebarListTab(undefined)).toBe("projects");
    expect(normalizeSidebarListTab("nope")).toBe("projects");
  });
});

describe("board tabs", () => {
  test("existing shortcuts remain stable while notes and revision diff stay available", () => {
    expect(BOARD_TABS[8]).toBe("bom");
    expect(BOARD_TAB_LABELS.bom).toBe("Shopping list");
    expect(BOARD_TABS[9]).toBe("art");
    expect(BOARD_TAB_LABELS.art).toBe("Art");
    expect(BOARD_TABS).toContain("notes");
    expect(BOARD_TAB_LABELS.notes).toBe("Notes");
    expect(BOARD_TABS.at(-1)).toBe("diff");
    expect(BOARD_TAB_LABELS.diff).toBe("Diff");
  });
});

describe("project context", () => {
  test("canceling the project picker keeps the current chat, draft and attachments", () => {
    const previous = useUiStore.getState();
    try {
      useUiStore.setState({ activeProjectId: "a", activeThreadId: "chat-a", drafts: { __new__: "pending draft" }, attachments: { __new__: [{ path: "sketch.png", mime: "image/png", label: "Sketch" }] } });
      useUiStore.getState().setProjectPickerOpen(true);
      useUiStore.getState().setProjectPickerOpen(false);
      expect(useUiStore.getState()).toMatchObject({ activeProjectId: "a", activeThreadId: "chat-a", drafts: { __new__: "pending draft" }, attachments: { __new__: [{ path: "sketch.png" }] } });
      useUiStore.getState().startNewChatInProject("b");
      expect(useUiStore.getState()).toMatchObject({ activeProjectId: "b", activeThreadId: null, projectPickerOpen: false, drafts: { __new__: "pending draft" }, attachments: { __new__: [{ path: "sketch.png" }] } });
      useUiStore.getState().startNewChatInProject(null);
      expect(useUiStore.getState()).toMatchObject({ activeProjectId: null, activeThreadId: null, projectPickerOpen: true });
    } finally { useUiStore.setState(previous); }
  });
  test("pinning is idempotent and does not switch the active chat", () => {
    const previous = useUiStore.getState();
    try {
      useUiStore.setState({ pinnedProjectIds: [], activeProjectId: "a", activeThreadId: "chat-a" });
      useUiStore.getState().setProjectPinned("b", true);
      useUiStore.getState().setProjectPinned("b", true);
      expect(useUiStore.getState().pinnedProjectIds).toEqual(["b"]);
      expect(useUiStore.getState().activeThreadId).toBe("chat-a");
      useUiStore.getState().setProjectPinned("b", false);
      expect(useUiStore.getState().pinnedProjectIds).toEqual([]);
    } finally { useUiStore.setState(previous); }
  });
  test("switching projects clears the previous conversation and project-specific screens", () => {
    const previous = useUiStore.getState();
    try {
      useUiStore.setState({ activeProjectId: "a", activeThreadId: "chat-a", orderFlowOpen: true, inventoryOpen: true, activeOpenSourceId: "catalog-a" });
      useUiStore.getState().setActiveProject("b");
      const state = useUiStore.getState();
      expect(state.activeProjectId).toBe("b");
      expect(state.activeThreadId).toBeNull();
      expect(state.activeOpenSourceId).toBeNull();
      expect(state.orderFlowOpen).toBe(false);
      expect(state.inventoryOpen).toBe(false);
    } finally { useUiStore.setState(previous); }
  });

  test("toggling the current project's folder preserves its open conversation", () => {
    const previous = useUiStore.getState();
    try {
      useUiStore.setState({ activeProjectId: "a", activeThreadId: "chat-a" });
      useUiStore.getState().setActiveProject("a");
      expect(useUiStore.getState().activeThreadId).toBe("chat-a");
    } finally { useUiStore.setState(previous); }
  });
});
