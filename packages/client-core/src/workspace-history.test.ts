import { expect, test } from "bun:test";
import { recordWorkspaceHistory, sameWorkspaceLocation, type WorkspaceHistoryEntry } from "./workspace-history";
const page = (area: WorkspaceHistoryEntry["area"], tab: string): WorkspaceHistoryEntry => ({ projectId: "p", area, tab, boardOpen: true, openSourceId: null, inventoryOpen: false, orderFlowOpen: false, board: null, filePath: null });
test("navigation records return context, without treating file selection as another page", () => {
  const before = { ...page("files", "files"), filePath: "exports/schematic.pdf" };
  expect(sameWorkspaceLocation(before, { ...before, filePath: "other.pdf" })).toBe(true);
  expect(recordWorkspaceHistory([], before, page("review", "drc"))).toEqual([before]);
  expect(recordWorkspaceHistory([before], page("review", "drc"), page("outputs", "renders"), true)).toEqual([before]);
});
test("back history never crosses projects or Home and keeps a bounded session", () => {
  const before = page("boards", "pcb"), after = page("review", "drc");
  expect(recordWorkspaceHistory([before], before, { ...after, projectId: "other" })).toEqual([]);
  expect(recordWorkspaceHistory([before], before, null)).toEqual([]);
  expect(recordWorkspaceHistory(Array.from({ length: 40 }, () => before), before, after)).toHaveLength(40);
});
