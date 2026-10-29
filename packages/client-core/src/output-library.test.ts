import { expect, test } from "bun:test";
import { filterSavedOutputs, outputKind, outputLibrarySections, savedOutputs } from "./output-library";

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

test("member outputs exclude blocked and undeclared source directories and retain their source labels", () => {
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


test("large native layer sets group without losing metadata, file order or unrelated outputs", () => {
  const layers = Array.from({ length: 7 }, (_, index) => ({ path: `boards/io/exports/gerbers/layer-${index}.gbr`, kind: "manufacturing" as const, sourceId: "io", size: index }));
  const packageFile = { path: "exports/fabrication.zip", kind: "manufacturing" as const, sourceId: "", size: 20 };
  const image = { path: "renders/top.png", kind: "images" as const, sourceId: "", size: 10 };
  const files = [packageFile, ...layers, image], sections = outputLibrarySections(files, true);
  expect(sections.cards).toEqual([packageFile, image]);
  expect(sections.manufacturingFiles).toEqual(layers);
  expect(sections.manufacturingFiles[0]).toBe(layers[0]!);
  expect(sections.cards.length + sections.manufacturingFiles.length).toBe(files.length);
  expect(outputLibrarySections(files, false)).toEqual({ cards: files, manufacturingFiles: [] });
});

test("small exports stay directly visible and DXF layer files share the counted set", () => {
  const files = Array.from({ length: 7 }, (_, index) => ({ path: `exports/dxf/layer-${index}.dxf`, kind: "manufacturing" as const }));
  expect(outputLibrarySections(files.slice(0, 6), true).cards).toHaveLength(6);
  expect(outputLibrarySections(files.slice(0, 6), true).manufacturingFiles).toEqual([]);
  expect(outputLibrarySections(files, true).manufacturingFiles).toHaveLength(7);
});


test("missing declared PCB sources retain saved outputs without inferring historical membership", () => {
  const sources = [
    { source: { id: "io", name: "I/O", location: "project" as const, directory: "boards/io" }, status: "missing" as const },
    { source: { id: "blocked", name: "Blocked", location: "project" as const, directory: "boards/blocked" }, status: "blocked" as const },
    { source: { id: "external", name: "External", location: "unresolved" as const, provenance: { path: "external/board.kicad_pcb", ref: "external-revision" } }, status: "unresolved" as const },
  ];
  const files = ["boards/io/renders/pcb.svg", "boards/io/renders/board.glb", "boards/io/exports/product-video.mp4", "boards/io/exports/gerbers/top.gtl", "boards/io/renders/board.glb.revision.json", "boards/old/renders/pcb.svg", "boards/blocked/renders/pcb.svg", "external/renders/pcb.svg"]
    .map(path => ({ path, mtime: "2026-10-28", size: 20 }));
  const rows = savedOutputs(files, sources);
  expect(rows).toHaveLength(4);
  expect(rows.every(row => row.sourceId === "io" && row.sourceName === "I/O")).toBe(true);
  expect(rows.map(row => row.kind).sort()).toEqual(["images", "manufacturing", "models", "videos"]);
  expect(savedOutputs(files, sources.map(row => row.source.id === "io" ? { ...row, status: "available" as const } : row))).toEqual(rows);
});


test("nested declared outputs never borrow ownership from an available ancestor", () => {
  const parent = { source: { id: "io", name: "I/O", location: "project" as const, directory: "boards/io" }, status: "available" as const };
  const child = { source: { id: "child", name: "Child", location: "project" as const, directory: "boards/io/renders/history" }, status: "blocked" as const };
  const files = ["boards/io/renders/pcb.svg", "boards/io/renders/history/renders/pcb.svg"].map(path => ({ path, mtime: "2026-10-28", size: 20 }));
  expect(savedOutputs(files, [parent, child]).map(row => row.sourceId)).toEqual(["io"]);
  const rows = savedOutputs(files, [parent, { ...child, status: "missing" }]);
  expect(rows.find(row => row.path === files[1]!.path)).toMatchObject({ sourceId: "child", sourceName: "Child" });
});


test("output search intersects kind and exact qualified source without changing order or file identity", () => {
  const files = [
    { path: "boards/io/renders/pcb.svg", kind: "images" as const, sourceId: "io", sourceName: "I/O main", size: 4 },
    { path: "boards/lcd/renders/pcb.svg", kind: "images" as const, sourceId: "lcd", sourceName: "LCD interface", size: 5 },
    { path: "exports/io-reference.png", kind: "images" as const, size: 6 },
    { path: "boards/io/exports/product-video.mp4", kind: "videos" as const, sourceId: "io", sourceName: "I/O main", size: 7 },
  ];
  const before = JSON.stringify(files);
  expect(filterSavedOutputs(files, { query: "  PCB  I/O  " })).toEqual([files[0]!]);
  expect(filterSavedOutputs(files, { kind: "images", sourceId: "io" })).toEqual([files[0]!]);
  expect(filterSavedOutputs(files, { sourceId: "io" })).toEqual([files[0]!, files[3]!]);
  expect(filterSavedOutputs(files, { sourceId: "IO" })).toEqual([]);
  expect(filterSavedOutputs(files, { sourceId: null })).toEqual([files[2]!]);
  expect(filterSavedOutputs(files, { query: "not-saved" })).toEqual([]);
  expect(filterSavedOutputs(files, { kind: "all", query: "   " })).toEqual(files);
  expect(filterSavedOutputs(files, { query: "LCD" })[0]).toBe(files[1]!);
  expect(JSON.stringify(files)).toBe(before);
});
