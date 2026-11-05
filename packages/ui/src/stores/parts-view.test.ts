import { expect, test } from "bun:test";
import { createUiStore } from "./ui";

test("Parts browsing survives workspace navigation without crossing project/core boundaries", () => {
  const ui = createUiStore({ getItem: () => null, setItem() {}, removeItem() {} });
  const key = "http://core-a/project-a";
  ui.getState().setActiveProject("project-a");
  ui.getState().rememberPartsView(key, { query: "USB", kinds: ["pcb"], buildQuantity: "12", sourcesOpen: true, scrollTop: 600, scrollLeft: 100 });
  ui.getState().setWorkspaceArea("boards");
  ui.getState().setWorkspaceArea("parts");
  expect(ui.getState().partsViewByProject[key]).toMatchObject({ query: "USB", kinds: ["pcb"], buildQuantity: "12", sourcesOpen: true, scrollTop: 600, scrollLeft: 100 });
  ui.getState().rememberPartsView(key, { query: "", scrollTop: 0 });
  expect(ui.getState().partsViewByProject[key]).toMatchObject({ query: "", scrollTop: 0, buildQuantity: "12", kinds: ["pcb"] });
  expect(ui.getState().partsViewByProject["http://core-b/project-a"]).toBeUndefined();
  expect(ui.getState().partsViewByProject["http://core-a/project-b"]).toBeUndefined();
});
