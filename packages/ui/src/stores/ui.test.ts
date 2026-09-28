import { describe, expect, test } from "bun:test";
import { BOARD_TABS, BOARD_TAB_LABELS, SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, newChatInProjectState, normalizeSidebarListTab } from "./ui";

describe("sidebar list tabs", () => {
  test("exposes Projects, Open source and Inventory", () => {
    expect(SIDEBAR_LIST_TABS).toEqual(["projects", "open_source", "inventory"]);
    expect(Object.keys(SIDEBAR_LIST_TAB_LABELS)).toEqual(["projects", "open_source", "inventory"]);
    expect(SIDEBAR_LIST_TAB_LABELS.inventory).toBe("Inventory");
    expect(SIDEBAR_LIST_TAB_LABELS.projects).toBe("Projects");
    expect(SIDEBAR_LIST_TAB_LABELS.open_source).toBe("Open source");
  });

  test("new chat in a project clears the thread and picker", () => {
    expect(newChatInProjectState("prj_amp")).toEqual({
      activeProjectId: "prj_amp",
      activeThreadId: null,
      activeOpenSourceId: null,
      orderFlowOpen: false,
      projectPickerOpen: false,
      sidebarListTab: "projects",
    });
    expect(newChatInProjectState(null).activeProjectId).toBeNull();
  });

  test("normalizes the removed Conversations tab onto Projects", () => {
    expect(normalizeSidebarListTab("conversations")).toBe("projects");
    expect(normalizeSidebarListTab("projects")).toBe("projects");
    expect(normalizeSidebarListTab("open_source")).toBe("open_source");
    expect(normalizeSidebarListTab("inventory")).toBe("inventory");
    expect(normalizeSidebarListTab(undefined)).toBe("projects");
    expect(normalizeSidebarListTab("nope")).toBe("projects");
  });
});

describe("board tabs", () => {
  test("the shopping list is the last board tab", () => {
    expect(BOARD_TABS.at(-1)).toBe("bom");
    expect(BOARD_TAB_LABELS.bom).toBe("Shopping list");
  });
});
