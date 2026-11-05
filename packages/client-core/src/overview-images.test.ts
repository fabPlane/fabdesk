import { expect, test } from "bun:test";
import { overviewBoardImages } from "./overview-images";
const files = (...paths: string[]) => paths.map(path => ({ path, size: 10, mtime: "2026-10-29" }));
const sources = [
  { source: { id: "io", name: "I/O", location: "project" as const, directory: "boards/io" }, status: "available" as const, previewPath: "boards/io/renders/pcb.svg" },
  { source: { id: "child", name: "Nested", location: "project" as const, directory: "boards/io/nested" }, status: "blocked" as const },
];
test("top renders take precedence; saved views and technical drawings remain fallback candidates", () => {
  expect(overviewBoardImages(files("renders/pcb.svg", "renders/bottom.png", "renders/top.png", "renders/schematic.svg")).map(row => row.kind)).toEqual(["top", "render", "pcb", "schematic"]);
});
test("no top render still uses an actual drawing and no image has no candidate", () => {
  expect(overviewBoardImages(files("renders/pcb.svg"))[0]?.kind).toBe("pcb");
  expect(overviewBoardImages(files("board.kicad_pcb", "renders/board.glb"))).toEqual([]);
});
test("member images never borrow a root, sibling or nested declared source's files", () => {
  const rows = overviewBoardImages(files("renders/top.png", "boards/other/renders/top.png", "boards/io/nested/renders/top.png", "boards/io/renders/pcb.svg", "boards/io/renders/top.png"), { sources, sourceId: "io" });
  expect(rows.map(row => row.path)).toEqual(["boards/io/renders/top.png", "boards/io/renders/pcb.svg"]);
});
test("blocked, unresolved and unknown source selections cannot acquire an image", () => {
  const inventory = files("boards/io/nested/renders/top.png", "renders/top.png");
  expect(overviewBoardImages(inventory, { sources, sourceId: "child" })).toEqual([]);
  expect(overviewBoardImages(inventory, { sources, sourceId: "unknown" })).toEqual([]);
  expect(overviewBoardImages(inventory, { sources: [{ ...sources[0]!, status: "unresolved" }], sourceId: "io" })).toEqual([]);
});
test("exclude unrelated images, comparisons, video posters and unsafe paths", () => {
  expect(overviewBoardImages(files("renders/enclosure.png", "renders/artwork.png", "renders/product-video-poster.png", "renders/pcb-overlay.svg", "photos/top.png", "../renders/top.png", "/renders/top.png", "renders//top.png"))).toEqual([]);
});
test("schematic-only projects keep their schematic view rather than using a saved PCB image", () => {
  expect(overviewBoardImages(files("renders/top.png", "renders/schematic.svg"), { schematicOnly: true }).map(row => row.kind)).toEqual(["schematic"]);
});
test("missing native source can retain its own saved render without a current-source claim", () => {
  const missing = [{ ...sources[0]!, status: "missing" as const }];
  expect(overviewBoardImages(files("boards/io/renders/populated-top.webp"), { sources: missing, sourceId: "io" })[0]?.kind).toBe("top");
});
