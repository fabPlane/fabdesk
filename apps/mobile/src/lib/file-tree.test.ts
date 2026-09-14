import { describe, expect, test } from "bun:test";
import {
  ancestorsOf,
  buildFileTree,
  fileKind,
  flattenTree,
  initialExpanded,
  isEditable,
  languageFor,
} from "./file-tree";

const entry = (path: string, size = 10) => ({ path, size, mtime: "2026-09-02T10:00:00Z" });

const files = [
  entry("renders/top.png", 300),
  entry("circuit.tsx", 50),
  entry("reports/drc.json", 20),
  entry("README.md", 5),
  entry("reports/erc.json", 30),
  entry("board.kicad_pcb", 1000),
  entry("exports/gerbers/F_Cu.gbr", 7),
];

describe("buildFileTree", () => {
  test("directories are implied by paths, sorted first, then files case-insensitively", () => {
    const root = buildFileTree(files);
    expect(root.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "dir:exports",
      "dir:renders",
      "dir:reports",
      "file:board.kicad_pcb",
      "file:circuit.tsx",
      "file:README.md",
    ]);
  });

  test("counts and sizes roll up through every ancestor", () => {
    const root = buildFileTree(files);
    expect(root.fileCount).toBe(7);
    expect(root.size).toBe(1412);
    const exports = root.children[0];
    if (exports?.kind !== "dir") throw new Error("expected dir");
    expect(exports.fileCount).toBe(1);
    expect(exports.size).toBe(7);
    const gerbers = exports.children[0];
    if (gerbers?.kind !== "dir") throw new Error("expected dir");
    expect(gerbers.path).toBe("exports/gerbers");
    expect(gerbers.children[0]?.path).toBe("exports/gerbers/F_Cu.gbr");
  });

  test("a leading slash does not create an empty directory", () => {
    const root = buildFileTree([entry("/a.txt")]);
    expect(root.children.map((c) => c.path)).toEqual(["a.txt"]);
  });
});

describe("flattenTree", () => {
  test("only expanded directories contribute rows; depth follows nesting", () => {
    const root = buildFileTree(files);
    const closed = flattenTree(root, new Set());
    expect(closed.map((r) => r.node.name)).toEqual([
      "exports",
      "renders",
      "reports",
      "board.kicad_pcb",
      "circuit.tsx",
      "README.md",
    ]);
    const open = flattenTree(root, new Set(["exports", "exports/gerbers"]));
    expect(open.slice(0, 4).map((r) => [r.node.name, r.depth, r.expanded])).toEqual([
      ["exports", 0, true],
      ["gerbers", 1, true],
      ["F_Cu.gbr", 2, false],
      ["renders", 0, false],
    ]);
  });

  test("initialExpanded opens the top-level directories only", () => {
    expect([...initialExpanded(buildFileTree(files))].sort()).toEqual([
      "exports",
      "renders",
      "reports",
    ]);
  });

  test("ancestorsOf lists what must be open to reach a path", () => {
    expect(ancestorsOf("exports/gerbers/F_Cu.gbr")).toEqual(["exports", "exports/gerbers"]);
    expect(ancestorsOf("a.txt")).toEqual([]);
  });
});

describe("file kinds", () => {
  test("kind by extension", () => {
    expect(fileKind("renders/top.png")).toBe("image");
    expect(fileKind("README.md")).toBe("markdown");
    expect(fileKind("exports/board.glb")).toBe("binary");
    expect(fileKind("board.kicad_pcb")).toBe("text");
    expect(fileKind("renders/schematic.svg")).toBe("text");
  });

  test("language by extension, KiCad files as s-expressions", () => {
    expect(languageFor("circuit.tsx")).toBe("ts");
    expect(languageFor("reports/drc.json")).toBe("json");
    expect(languageFor("board.kicad_pro")).toBe("json");
    expect(languageFor("board.kicad_pcb")).toBe("sexpr");
    expect(languageFor("notes.md")).toBe("markdown");
    expect(languageFor("Makefile")).toBe("plain");
  });

  test("editable: text and markdown under the size cap, never the manifest", () => {
    expect(isEditable("circuit.tsx", 100)).toBe(true);
    expect(isEditable("README.md", 100)).toBe(true);
    expect(isEditable("fabdesk.json", 100)).toBe(false);
    expect(isEditable("renders/top.png", 100)).toBe(false);
    expect(isEditable("big.txt", 2_000_000)).toBe(false);
  });
});
