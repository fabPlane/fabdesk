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

test("member outputs come only from explicitly available source directories and retain their source labels", () => {
  const sources = [
    { source: { id: "io", name: "I/O", location: "project" as const, directory: "boards/io" }, status: "available" as const },
    { source: { id: "blocked", name: "Blocked", location: "project" as const, directory: "boards/blocked" }, status: "blocked" as const },
  ];
  const files = ["boards/io/renders/board.glb", "boards/io/renders/board.glb.revision.json", "boards/io/exports/top.png", "boards/old/renders/board.glb", "boards/blocked/renders/board.glb", "exports/enclosure.stl"].map(path => ({ path, mtime: "2026-10-28", size: 20 }));
  const rows = savedOutputs(files, sources);
  expect(rows.map(row => row.path)).toEqual(["boards/io/exports/top.png", "boards/io/renders/board.glb", "exports/enclosure.stl"]);
  expect(rows[1]).toMatchObject({ sourceId: "io", sourceName: "I/O", kind: "models" });
  expect(rows[2]!.sourceId).toBeUndefined();
});

test("actual native paste and board-edge Gerbers remain visible manufacturing outputs", () => {
  for (const path of ["exports/gerbers/board-F_Paste.gtp", "exports/gerbers/board-B_Paste.gbp", "exports/gerbers/board-Edge_Cuts.gm1"]) {
    expect(outputKind(path)).toBe("manufacturing");
    expect(savedOutputs([{ path, size: 1, mtime: "2026-10-29" }])[0]?.path).toBe(path);
  }
});
