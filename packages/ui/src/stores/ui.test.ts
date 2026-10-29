import { describe, expect, test } from "bun:test";
import { newChatDraftKey, BOARD_TABS, BOARD_TAB_LABELS, SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, newChatInProjectState, normalizeSidebarListTab, migrateProjectDraftSlot, createUiStore, useUiStore } from "./ui";

test("unfinished notes stay separate across projects, hosts and chat drafts during navigation", () => {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const store = createUiStore(storage);
  const a = JSON.stringify(["http://local", "project-a"]), b = JSON.stringify(["http://remote", "project-a"]);
  store.getState().setDraft(newChatDraftKey("project-a"), "Existing unsent question");
  store.getState().setNotesDraft(a, { base: "Saved", content: "Local note draft" });
  store.getState().setActiveProject("project-b");
  store.getState().setNotesDraft(b, { base: "Other saved", content: "Remote note draft" });
  expect(store.getState().notesDrafts[a]?.content).toBe("Local note draft");
  expect(store.getState().notesDrafts[b]?.base).toBe("Other saved");
  expect(store.getState().drafts[newChatDraftKey("project-a")]).toBe("Existing unsent question");
  store.getState().setNotesDraft(a, null);
  expect(store.getState().notesDrafts[a]).toBeUndefined();
  expect(store.getState().notesDrafts[b]?.content).toBe("Remote note draft");
  expect(createUiStore(storage).getState().notesDrafts).toEqual({}); // Session-only, no reload-recovery promise.
});

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
    expect(BOARD_TABS[11]).toBe("diff");
    expect(BOARD_TABS[12]).toBe("comments");
    expect(BOARD_TABS.at(-1)).toBe("updates");
    expect(BOARD_TAB_LABELS.comments).toBe("Comments");
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


test("review comment navigation stays in its project and never leaks into another project", () => {
  const store = createUiStore();
  store.getState().openBoardComment("cmt_none", "pcb");
  expect(store.getState().commentToReveal).toBeNull();
  store.getState().setActiveProject("a");
  store.getState().setWorkspaceArea("review");
  store.getState().openBoardComment("cmt_a", "schematic");
  expect(store.getState().commentToReveal).toEqual({ projectId: "a", id: "cmt_a", view: "schematic" });
  expect(store.getState().workspaceArea).toBe("boards");
  expect(store.getState().boardTab).toBe("schematic");
  store.getState().setActiveProject("b");
  expect(store.getState().commentToReveal).toBeNull();
  expect(store.getState().boardTab).toBe("pcb");
});


test("opening another project closes inherited canvas panes without discarding drafts; explicit conversation selection reopens chat", () => {
  const store = createUiStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  store.getState().setActiveProject("a"); store.getState().setDraft(newChatDraftKey("a"), "Keep this sketch discussion");
  store.getState().focusComposer(); store.getState().setCanvasNavigationOpen(true);
  store.getState().setActiveProject("a"); expect(store.getState().assistantOpen).toBe(true);
  store.getState().setActiveProject("b");
  expect(store.getState().assistantOpen).toBe(false); expect(store.getState().canvasNavigationOpen).toBe(false);
  expect(store.getState().drafts[newChatDraftKey("a")]).toBe("Keep this sketch discussion");
  store.getState().setActiveThread("chat-b"); expect(store.getState().assistantOpen).toBe(true);
  store.getState().setWorkspaceArea("review"); store.getState().setWorkspaceTab("comments");
  store.getState().setDraft("chat-b", "Keep this unsent question");
  store.getState().addAttachment("chat-b", { path: "sketches/reference.png", mime: "image/png", label: "reference" });
  store.getState().setCanvasNavigationOpen(true);
  store.getState().setActiveProject("b"); // Picking a conversation in the current project.
  store.getState().setActiveThread("chat-b");
  expect(store.getState().canvasNavigationOpen).toBe(false);
  expect(store.getState().activeProjectId).toBe("b");
  expect(store.getState().boardTab).toBe("comments");
  expect(store.getState().drafts["chat-b"]).toBe("Keep this unsent question");
  expect(store.getState().attachments["chat-b"]?.[0]?.path).toBe("sketches/reference.png");
  store.getState().setCanvasNavigationOpen(true);
  store.getState().startNewChatInProject("b");
  expect(store.getState().canvasNavigationOpen).toBe(false);
  expect(store.getState().activeThreadId).toBeNull();
  expect(store.getState().activeProjectId).toBe("b");
  expect(store.getState().boardTab).toBe("comments");
  expect(store.getState().drafts["chat-b"]).toBe("Keep this unsent question");
  expect(store.getState().attachments["chat-b"]?.[0]?.path).toBe("sketches/reference.png");
});


test("comparison is opt-in and remembered per project without opening it for another project", async () => {
  let snapshot: string | null = null;
  const storage = { getItem: () => snapshot, setItem: (_key: string, value: string) => { snapshot = value; }, removeItem: () => {} };
  const store = createUiStore(storage); store.getState().setActiveProject("a");
  expect(store.getState().boardComparisonByProject.a).toBeUndefined();
  store.getState().setBoardComparison(true); store.getState().setActiveProject("b");
  expect(store.getState().boardComparisonByProject.b).toBeUndefined();
  const reopened = createUiStore(storage); await reopened.persist.rehydrate();
  reopened.getState().setActiveProject("a"); expect(reopened.getState().boardComparisonByProject.a).toBe(true);
  reopened.getState().setBoardComparison(false); expect(reopened.getState().boardComparisonByProject.a).toBe(false);
});

test("board workspaces survive reloads, isolate projects and reject cross-project writes", () => {
  let stored: string | null = null;
  const memory = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; }, removeItem: () => { stored = null; } };
  const store = createUiStore(memory);
  store.getState().setActiveProject("a");
  const selection = { projectId: "a", instanceId: "left", sourceId: "io", manifestSha256: "a".repeat(64) };
  store.getState().setAssemblyBoard(selection);
  selection.instanceId = "changed-after-selection";
  store.getState().setActiveProject("b");
  store.getState().setAssemblyBoard({ ...selection, instanceId: "wrong-project" });
  expect(store.getState().assemblyBoardByProject.b).toBeUndefined();
  store.getState().setAssemblyBoard({ ...selection, projectId: "b", instanceId: "right" });
  const reopened = createUiStore(memory);
  expect(reopened.getState().assemblyBoardByProject.a?.instanceId).toBe("left");
  expect(reopened.getState().assemblyBoardByProject.b?.instanceId).toBe("right");
  reopened.getState().setAssemblyBoard(null);
  expect(reopened.getState().assemblyBoardByProject.b).toBeUndefined();
  expect(reopened.getState().assemblyBoardByProject.a?.instanceId).toBe("left");
});

test("assembly finding navigation is copied, source-qualified, transient and cleared across projects", () => {
  let saved = "";
  const store = createUiStore({ getItem: () => null, setItem: (_key, value) => { saved = value; }, removeItem: () => {} });
  store.getState().setActiveProject("p");
  const finding = { selection: { projectId: "p", sourceId: "io", instanceId: "right", manifestSha256: "a".repeat(64) }, sourceSha256: "b".repeat(64), point: { x: 107, y: 100 }, description: "Clearance", itemDescription: "Track" };
  store.getState().openAssemblyFinding(finding);
  finding.point.x = 999; finding.selection.sourceId = "other";
  expect(store.getState().assemblyFinding?.point.x).toBe(107);
  expect(store.getState().assemblyBoardByProject.p?.instanceId).toBe("right");
  expect(store.getState().boardTab).toBe("pcb");
  expect(JSON.parse(saved).state.assemblyFinding).toBeUndefined();
  store.getState().setActiveProject("q");
  expect(store.getState().assemblyFinding).toBeNull();
  store.getState().openAssemblyFinding(finding);
  expect(store.getState().assemblyFinding).toBeNull();
});

test("saved root check navigation copies its point and cannot leak into another project", () => {
  const store = createUiStore(); store.getState().setActiveProject("a");
  const finding = { endpoint: "http://local", projectId: "a", sourceSha256: "a".repeat(64), reportFingerprint: "report", point: { x: 2, y: 3 }, description: "Short", itemDescription: "Pad" };
  store.getState().openRootFinding(finding); finding.point.x = 99;
  expect(store.getState().rootFinding?.point.x).toBe(2);
  expect(store.getState().boardTab).toBe("pcb");
  store.getState().setActiveProject("b");
  expect(store.getState().rootFinding).toBeNull();
  store.getState().openRootFinding(finding);
  expect(store.getState().rootFinding).toBeNull();
});


test("area tab choices survive other tasks, project switches and reload without changing drafts", () => {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const store = createUiStore(storage);
  store.getState().setActiveProject("a");
  store.getState().setDraft(newChatDraftKey("a"), "Keep my question");
  store.getState().addAttachment(newChatDraftKey("a"), { path: "sketches/a.png", mime: "image/png", label: "a" });
  store.getState().setWorkspaceArea("files"); store.getState().setWorkspaceTab("notes");
  store.getState().setWorkspaceArea("review"); store.getState().setWorkspaceTab("diff");
  store.getState().setWorkspaceArea("outputs"); store.getState().setWorkspaceTab("3d");
  store.getState().setWorkspaceArea("files"); expect(store.getState().boardTab).toBe("notes");
  store.getState().setWorkspaceArea("review"); expect(store.getState().boardTab).toBe("diff");
  store.getState().setActiveProject("b");
  store.getState().setWorkspaceArea("files"); expect(store.getState().boardTab).toBe("files");
  store.getState().setWorkspaceArea("review"); expect(store.getState().boardTab).toBe("updates");
  store.getState().setActiveProject("a");
  const restored = createUiStore(storage);
  restored.getState().setWorkspaceArea("outputs"); expect(restored.getState().boardTab).toBe("3d");
  restored.getState().setWorkspaceArea("files"); expect(restored.getState().boardTab).toBe("notes");
  expect(restored.getState().drafts[newChatDraftKey("a")]).toBe("Keep my question");
  expect(restored.getState().attachments[newChatDraftKey("a")]).toEqual([{ path: "sketches/a.png", mime: "image/png", label: "a" }]);
  restored.getState().setBoardTab("drc"); expect(restored.getState().boardTab).toBe("drc");
  restored.getState().setWorkspaceArea("files"); restored.getState().setWorkspaceArea("review");
  expect(restored.getState().boardTab).toBe("drc");
  restored.getState().openProjectFile("board.kicad_pcb");
  expect(restored.getState().boardTab).toBe("files");
  restored.getState().setWorkspaceArea("boards"); restored.getState().setWorkspaceArea("files");
  expect(restored.getState().boardTab).toBe("files");
  expect(restored.getState().fileToReveal).toEqual({ projectId: "a", path: "board.kicad_pcb" });
});

test("older profiles learn their current tab; invalid saved area tabs use the area's default", () => {
  let snapshot = JSON.stringify({ version: 7, state: { activeProjectId: "a", canvasMode: true, workspaceArea: "files", boardTab: "notes", workspaceByProject: { a: { area: "files", tab: "notes" } } } });
  const storage = { getItem: () => snapshot, setItem: (_key: string, value: string) => { snapshot = value; }, removeItem: () => {} };
  const store = createUiStore(storage);
  expect(store.getState().workspaceTabsByProject).toEqual({});
  store.getState().setWorkspaceArea("boards"); store.getState().setWorkspaceArea("files");
  expect(store.getState().boardTab).toBe("notes");
  const raw = JSON.parse(snapshot); raw.state.workspaceTabsByProject.a.review = "notes";
  snapshot = JSON.stringify(raw);
  const restored = createUiStore(storage); restored.getState().setWorkspaceArea("review");
  expect(restored.getState().boardTab).toBe("updates");
});


test("map view positions persist per endpoint and project without changing drafts or workspace tools", () => {
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };
  const store = createUiStore(storage), local = JSON.stringify(["http://local", "a"]), remote = JSON.stringify(["http://remote", "a"]);
  store.getState().setActiveProject("a");
  store.getState().setDraft(newChatDraftKey("a"), "Unsent project question");
  const tab = store.getState().boardTab, point = { units: "canvas-px" as const, sourceId: "io", x: 30, y: -50 };
  store.getState().setAssemblyMapPosition(local, "a", "left", point);
  point.x = 999;
  store.getState().setAssemblyMapPosition(remote, "a", "left", { units: "canvas-px" as const, sourceId: "io", x: 80, y: 90 });
  expect(store.getState().assemblyMapLayouts[local]?.left?.x).toBe(30);
  expect(store.getState().assemblyMapLayouts[remote]?.left?.x).toBe(80);
  expect(store.getState().boardTab).toBe(tab);
  expect(store.getState().assistantOpen).toBe(false);
  expect(store.getState().drafts[newChatDraftKey("a")]).toBe("Unsent project question");
  expect(createUiStore(storage).getState().assemblyMapLayouts).toEqual(store.getState().assemblyMapLayouts);
  store.getState().resetAssemblyMapLayout(local, "a");
  expect(store.getState().assemblyMapLayouts[local]).toBeUndefined();
  expect(store.getState().assemblyMapLayouts[remote]?.left?.x).toBe(80);
});
test("stale project events and invalid coordinates cannot save or reset another project map", () => {
  const store = createUiStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), a = JSON.stringify(["http://local", "a"]), b = JSON.stringify(["http://local", "b"]);
  store.getState().setActiveProject("a");
  store.getState().setAssemblyMapPosition(a, "a", "left", { units: "canvas-px" as const, sourceId: "io", x: 20, y: 40 });
  for (const x of [NaN, Infinity, -Infinity, 1e6 + 1]) store.getState().setAssemblyMapPosition(a, "a", "left", { units: "canvas-px" as const, sourceId: "io", x, y: 40 });
  expect(store.getState().assemblyMapLayouts[a]?.left?.x).toBe(20);
  store.getState().setActiveProject("b");
  store.getState().setAssemblyMapPosition(a, "a", "left", { units: "canvas-px" as const, sourceId: "io", x: 400, y: 500 });
  store.getState().resetAssemblyMapLayout(a, "a");
  store.getState().setAssemblyMapPosition(b, "b", "left", { units: "canvas-px" as const, sourceId: "carrier", x: 70, y: 80 });
  expect(store.getState().assemblyMapLayouts[a]?.left?.x).toBe(20);
  expect(store.getState().assemblyMapLayouts[b]?.left?.sourceId).toBe("carrier");
});
