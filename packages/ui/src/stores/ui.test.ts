import { describe, expect, test } from "bun:test";
import { BOARD_TABS, BOARD_TAB_LABELS, SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, newChatInProjectState, normalizeSidebarListTab, migrateProjectDraftSlot, createUiStore, useUiStore } from "./ui";

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
    expect(newChatInProjectState(null).activeProjectId).toBeNull();
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

describe("sketch-first draft adoption", () => {
  test("adopts the blank chat text and attachments into the new project", () => {
    const previous = useUiStore.getState();
    try {
      useUiStore.setState({ activeProjectId: null, activeThreadId: null, drafts: { __new__: "Use this sketch" }, attachments: { __new__: [{ path: "/reference.txt", mime: "text/plain", label: "reference" }] } });
      useUiStore.getState().adoptSketchProject("sketch-project");
      const state = useUiStore.getState();
      expect(state.activeProjectId).toBe("sketch-project");
      expect(state.drafts["__new__:sketch-project"]).toBe("Use this sketch");
      expect(state.attachments["__new__:sketch-project"]?.[0]?.path).toBe("/reference.txt");
      expect(state.drafts.__new__).toBe("");
    } finally { useUiStore.setState(previous); }
  });
  test("a late project creation does not move the user out of another chat", () => {
    const previous = useUiStore.getState();
    try {
      useUiStore.setState({ activeProjectId: "other", activeThreadId: "other-chat", drafts: { __new__: "Keep" } });
      useUiStore.getState().adoptSketchProject("sketch-project");
      expect(useUiStore.getState().activeProjectId).toBe("other");
      expect(useUiStore.getState().activeThreadId).toBe("other-chat");
      expect(useUiStore.getState().drafts.__new__).toBe("Keep");
    } finally { useUiStore.setState(previous); }
  });
});

 test("legacy unsent slots migrate without overwriting an existing project draft", () => {
  expect(migrateProjectDraftSlot({ __new__: "Legacy" }, "a")).toEqual({ "__new__:a": "Legacy" });
  expect(migrateProjectDraftSlot({ __new__: "Legacy", "__new__:a": "Saved" }, "a")).toEqual({ __new__: "Legacy", "__new__:a": "Saved" });
  expect(migrateProjectDraftSlot(undefined, "a")).toBeUndefined();
});

test("saved sketch attachments survive UI-store rehydration in their project slot", async () => {
  let snapshot: string | null = null;
  const storage = { getItem: () => snapshot, setItem: (_name: string, value: string) => { snapshot = value; }, removeItem: () => { snapshot = null; } };
  const first = createUiStore(storage);
  first.setState({ activeProjectId: "a", activeThreadId: null, drafts: { "__new__:a": "Build this" }, attachments: { "__new__:a": [{ path: "sketches/a.png", mime: "image/png", label: "a.png" }] } });
  const reopened = createUiStore(storage);
  await reopened.persist.rehydrate();
  expect(reopened.getState().activeProjectId).toBe("a");
  expect(reopened.getState().drafts["__new__:a"]).toBe("Build this");
  expect(reopened.getState().attachments["__new__:a"]?.[0]?.path).toBe("sketches/a.png");
});

test("version 5 drafts migrate even while an existing conversation is open", async () => {
  let snapshot = JSON.stringify({ version: 5, state: { activeProjectId: "a", activeThreadId: "chat-a", drafts: { __new__: "Unsent new chat", "chat-a": "Existing chat draft" } } });
  const reopened = createUiStore({ getItem: () => snapshot, setItem: (_name, value) => { snapshot = value; }, removeItem: () => {} });
  await reopened.persist.rehydrate();
  expect(reopened.getState().drafts["__new__:a"]).toBe("Unsent new chat");
  expect(reopened.getState().drafts["chat-a"]).toBe("Existing chat draft");
  expect(reopened.getState().activeThreadId).toBe("chat-a");
});

test("profiles without the old attachments field retain a usable empty attachment store", async () => {
  let snapshot = JSON.stringify({ version: 6, state: { activeProjectId: "a", drafts: { "__new__:a": "Keep" } } });
  const reopened = createUiStore({ getItem: () => snapshot, setItem: (_name, value) => { snapshot = value; }, removeItem: () => {} });
  await reopened.persist.rehydrate();
  expect(reopened.getState().attachments).toEqual({});
  expect(reopened.getState().drafts["__new__:a"]).toBe("Keep");
});

describe("canvas workspace state", () => {
  const memory = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  test("starts with one canvas and closed secondary panes; the classic layout remains reversible", () => {
    const store = createUiStore(memory());
    expect(store.getState().canvasMode).toBe(true);
    expect(store.getState().assistantOpen).toBe(false);
    expect(store.getState().canvasNavigationOpen).toBe(false);
    store.getState().toggleSidebar();
    expect(store.getState().canvasNavigationOpen).toBe(true);
    store.getState().setCanvasMode(false);
    expect(store.getState().canvasNavigationOpen).toBe(false);
    store.getState().setCanvasMode(true);
    expect(store.getState().canvasMode).toBe(true);
  });
  test("each project restores its own working destination and local tab", () => {
    const store = createUiStore(memory());
    store.getState().setActiveProject("a");
    store.getState().setWorkspaceArea("outputs");
    store.getState().setWorkspaceTab("3d");
    store.getState().setActiveProject("b");
    expect(store.getState().boardTab).toBe("pcb");
    store.getState().setBoardTab("drc");
    store.getState().setActiveProject("a");
    expect(store.getState().workspaceArea).toBe("outputs");
    expect(store.getState().boardTab).toBe("3d");
    store.getState().setActiveProject("b");
    expect(store.getState().workspaceArea).toBe("review");
    expect(store.getState().boardTab).toBe("drc");
  });
  test("file links and conversation selection reveal the intended tool instead of leaving a hidden destination", () => {
    const store = createUiStore(memory());
    store.getState().setActiveProject("a");
    store.getState().openProjectFile("board.kicad_pcb");
    expect(store.getState().workspaceArea).toBe("files");
    store.getState().setActiveThread("chat-a");
    expect(store.getState().assistantOpen).toBe(true);
    store.getState().setWorkspaceArea("mechanical");
    expect(store.getState().boardTab).toBe("cad");
  });
});
