import { expect, test } from "bun:test";
import { buildFileTree, fileAppearance } from "./file-explorer";

test("nested folders sort before files and preserve original read paths", () => {
  const tree = buildFileTree([
    { path: "board.kicad_pcb", size: 100 },
    { path: "exports/stencil/F-Paste.stl", size: 30 },
    { path: "exports/stencil/F-Paste.svg", size: 20 },
    { path: "source\\code.ts", size: 10 },
    { path: "exports/report10.txt", size: 10 },
    { path: "exports/report2.txt", size: 10 },
  ]);
  expect(tree.map((n) => n.name)).toEqual(["exports", "source", "board.kicad_pcb"]);
  expect(tree[0]!.children.map((n) => n.name)).toEqual(["stencil", "report2.txt", "report10.txt"]);
  expect(tree[0]!.children[0]!.children).toHaveLength(2);
  expect(tree[1]!.children[0]!.file?.path).toBe("source\\code.ts");
});

test("search keeps the matching hierarchy, including folder searches", () => {
  const files = [{ path: "exports/stencil/F-Paste.svg", size: 1 }, { path: "board.kicad_pcb", size: 2 }];
  expect(buildFileTree(files, "  SVG  ")[0]?.children[0]?.children[0]?.file?.path).toBe(files[0]!.path);
  expect(buildFileTree(files, "stencil")).toHaveLength(1);
  expect(buildFileTree(files, "missing")).toEqual([]);
  expect(buildFileTree([])).toEqual([]);
});

test("files and directories with similar names are not confused", () => {
  const tree = buildFileTree([{ path: "a.txt", size: 1 }, { path: "a.txt.bak/data.txt", size: 1 }]);
  expect(tree[0]?.file).toBeUndefined();
  expect(tree[1]?.file?.path).toBe("a.txt");
});

test("binary CAD, drawings and unknown formats never enter the text preview", () => {
  for (const path of ["part.STL", "part.3mf", "part.step", "shape.DXF", "paper.pdf", "part.zip", "unknown.bin", "extensionless"]) {
    expect(fileAppearance(path).preview).toBe("none");
  }
  expect(fileAppearance("shape.DXF")).toEqual({ kind: "drawing", label: "DXF", preview: "none" });
  expect(fileAppearance("folder.PNG/readme.TXT").preview).toBe("text");
  expect(fileAppearance("exports/F-Paste.SVG").preview).toBe("image");
  expect(fileAppearance("source/code.ts").kind).toBe("code");
  expect(fileAppearance("board.kicad_pcb").kind).toBe("board");
  expect(fileAppearance("exports/stencil/F-Paste-laser.lbrn2")).toEqual({
    kind: "data",
    label: "LBRN2",
    preview: "text",
  });
});
