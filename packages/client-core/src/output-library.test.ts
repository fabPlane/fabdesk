import { expect, test } from "bun:test";
import { outputKind, savedOutputs } from "./output-library";

test("saved outputs include media/models/manufacturing without treating receipts, reports or sources as deliverables", () => {
  for (const path of ["renders/board.glb.revision.json", "reports/drc.json", "board.kicad_pcb", "mechanical/imports/id/case.stl", "exports/.temporary"]) expect(outputKind(path)).toBeNull();
  expect(outputKind("renders/top.PNG")).toBe("images"); expect(outputKind("exports/product-video.gif")).toBe("videos");
  expect(outputKind("exports/enclosure.stl")).toBe("models"); expect(outputKind("exports/gerbers/board-F_Cu.gbr")).toBe("manufacturing");
  expect(outputKind("exports/stencil.lbrn2")).toBe("manufacturing");
});
test("output listing keeps distinct saved formats/paths and sorts actual timestamps without inventing revisions", () => {
  const rows = savedOutputs([{ path: "exports/video.mp4", size: 4, mtime: "2026-10-26" }, { path: "renders/top.png", size: 3, mtime: "2026-10-27" }, { path: "exports/video.webm", size: 2, mtime: "2026-10-26" }, { path: "board.kicad_pcb", size: 1, mtime: "2026-10-28" }]);
  expect(rows.map(row => row.path)).toEqual(["renders/top.png", "exports/video.mp4", "exports/video.webm"]);
  expect(rows[0]).toEqual({ path: "renders/top.png", size: 3, mtime: "2026-10-27", kind: "images" });
});
