import { expect, test } from "bun:test";
import { WORKSPACE_AREAS, workspaceAreaForView, workspaceViews, workspaceTabForArea } from "./workspace-navigation";

test("every existing view stays reachable after grouping; 3D and files can belong to explicit output tasks", () => {
  const available = new Set<string>(Object.keys(WORKSPACE_AREAS).flatMap((area) => workspaceViews(area as keyof typeof WORKSPACE_AREAS).map((v) => v.tab)));
  for (const view of ["schematic", "pcb", "system", "cinema", "3d", "cad", "drc", "renders", "files", "bom", "art", "notes", "diff", "comments", "placement"]) expect(available.has(view)).toBe(true);
  expect(workspaceViews("outputs").map((v) => v.tab)).toContain("3d");
  expect(workspaceViews("review")[0]?.tab).toBe("updates");
  expect(workspaceAreaForView("updates")).toBe("review");
  expect(workspaceAreaForView("diff")).toBe("review");
  expect(workspaceAreaForView("comments")).toBe("review");
  expect(workspaceAreaForView("cad")).toBe("mechanical");
  expect(workspaceAreaForView("notes")).toBe("files");
});


test("area preferences accept only offered tabs, including shared 3D tasks", () => {
  expect(workspaceTabForArea("files", "notes")).toBe("notes");
  expect(workspaceTabForArea("review", "diff")).toBe("diff");
  expect(workspaceTabForArea("outputs", "3d")).toBe("3d");
  expect(workspaceTabForArea("boards", "3d")).toBe("3d");
  expect(workspaceTabForArea("boards", "placement")).toBe("placement");
  for (const invalid of ["notes", "removed", null, { tab: "drc" }, ["drc"]]) expect(workspaceTabForArea("review", invalid)).toBe("updates");
  expect(workspaceTabForArea("overview", "pcb")).toBeNull();
});

test("connections and history are their own destinations, listed after the board", () => {
  const areas = Object.keys(WORKSPACE_AREAS);
  expect(areas.indexOf("connections")).toBe(areas.indexOf("boards") + 1);
  expect(areas.indexOf("history")).toBe(areas.indexOf("boards") + 2);
  expect(workspaceViews("connections")).toEqual([]);
  expect(workspaceViews("history")).toEqual([]);
  expect(workspaceTabForArea("history", "pcb")).toBeNull();
});
