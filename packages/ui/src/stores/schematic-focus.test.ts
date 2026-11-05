import { expect, test } from "bun:test";
import type { SchematicFocus } from "@fabdesk/protocol";
import { createUiStore } from "./ui";
const focus = (): SchematicFocus => ({ id: crypto.randomUUID(), projectId: "project-a", requestedAt: Date.now(), reference: "U1", value: "ESP32", sourcePath: "board.kicad_sch", sourceSha256: "a".repeat(64), svgPath: ".fabdesk/canvas-focus/a.svg", svgSha256: "b".repeat(64), points: [{ x: 80, y: 100, unit: 1 }], page: { width: 170, height: 660 } });
const store = () => createUiStore({ getItem: () => null, setItem() {}, removeItem() {} });
test("focus follows only a live already-open project and never replays across Home or project changes", () => {
  const s = store(), request = focus(); s.getState().requestSchematicFocus(focus(), "local"); expect(s.getState().activeProjectId).toBeNull();
  s.getState().setActiveProject("project-a"); s.getState().requestSchematicFocus({ ...focus(), requestedAt: Date.now() - 60_000 }, "local"); expect(s.getState().schematicFocus).toBeNull();
  s.getState().requestSchematicFocus(request, "local"); expect(s.getState().boardTab).toBe("schematic"); expect(s.getState().schematicFocus?.focus.reference).toBe("U1");
  s.getState().clearSchematicFocus(); s.getState().requestSchematicFocus(request, "local"); expect(s.getState().schematicFocus).toBeNull();
  s.getState().setWorkspaceArea("outputs"); s.getState().requestSchematicFocus(request, "local"); expect(s.getState().workspaceArea).toBe("outputs");
  s.getState().closeProject(); expect(s.getState().schematicFocus).toBeNull(); s.getState().setActiveProject("project-b"); s.getState().requestSchematicFocus(focus(), "local"); expect(s.getState().schematicFocus).toBeNull();
});
test("focus does not interrupt unsaved work or modal settings", () => {
  const s = store(); s.getState().setActiveProject("project-a");
  s.setState({ projectExitBlocks: { draft: { projectId: "project-a", message: "Unsaved comment" } } });
  s.getState().requestSchematicFocus(focus(), "local"); expect(s.getState().schematicFocus).toBeNull();
  s.setState({ projectExitBlocks: {}, settingsOpen: true }); s.getState().requestSchematicFocus(focus(), "local"); expect(s.getState().schematicFocus).toBeNull();
});
test("Return restores the prior page and repeated focus does not replace the original return destination", () => {
  const s = store(); s.getState().setActiveProject("project-a"); s.getState().setWorkspaceArea("outputs");
  const before = { area: s.getState().workspaceArea, tab: s.getState().boardTab };
  s.getState().requestSchematicFocus(focus(), "local"); s.getState().requestSchematicFocus(focus(), "local");
  s.getState().clearSchematicFocus();
  expect(s.getState().workspaceArea).toBe(before.area); expect(s.getState().boardTab).toBe(before.tab);
  s.getState().setSchematicPage("local/project-a/io/revision", "sheet-2.svg");
  expect(s.getState().schematicPageBySource["local/project-a/io/revision"]).toBe("sheet-2.svg");
  expect(s.getState().schematicPageBySource["local/project-a/other/revision"]).toBeUndefined();
});
test("manual navigation dismisses focus and late requests from another core cannot take over", () => {
  const s = store(); s.getState().setActiveProject("project-a"); s.getState().setNavigationEndpoint("local");
  s.getState().requestSchematicFocus(focus(), "other core"); expect(s.getState().schematicFocus).toBeNull();
  s.getState().requestSchematicFocus(focus(), "local"); expect(s.getState().schematicFocus).not.toBeNull();
  s.getState().setWorkspaceArea("outputs"); expect(s.getState().schematicFocus).toBeNull();
  s.getState().clearSchematicFocus(); expect(s.getState().workspaceArea).toBe("outputs");
});
