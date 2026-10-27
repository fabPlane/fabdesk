import { expect, test } from "bun:test";
import { WORKSPACE_AREAS, workspaceAreaForView, workspaceViews } from "./workspace-navigation";

test("every existing view stays reachable after grouping; 3D and files can belong to explicit output tasks", () => {
  const available = new Set<string>(Object.keys(WORKSPACE_AREAS).flatMap((area) => workspaceViews(area as keyof typeof WORKSPACE_AREAS).map((v) => v.tab)));
  for (const view of ["schematic", "pcb", "cinema", "3d", "cad", "drc", "renders", "files", "bom", "art", "notes", "diff", "comments"]) expect(available.has(view)).toBe(true);
  expect(workspaceViews("outputs").map((v) => v.tab)).toContain("3d");
  expect(workspaceAreaForView("diff")).toBe("review");
  expect(workspaceAreaForView("comments")).toBe("review");
  expect(workspaceAreaForView("cad")).toBe("mechanical");
  expect(workspaceAreaForView("notes")).toBe("files");
});
