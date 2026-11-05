import { expect, test } from "bun:test";
import { isBackupBoard, sortImportedBoards } from "./imported-boards";
test("root first, numeric versions descending, deterministic unversioned paths without mutating discovery", () => {
  const paths = ["versions/v9/board.kicad_pcb", "misc/z.kicad_pcb", "versions/v4.1/b.kicad_pcb", "board.kicad_pcb", "versions/v10/b.kicad_pcb", "versions/v4.0/b.kicad_pcb", "misc/a.kicad_pcb"];
  const original = [...paths];
  expect(sortImportedBoards(paths)).toEqual([paths[3]!, paths[4]!, paths[0]!, paths[2]!, paths[5]!, paths[6]!, paths[1]!]);
  expect(paths).toEqual(original);
  expect(sortImportedBoards([...paths].reverse())).toEqual(sortImportedBoards(paths));
});
test("path sort is numeric A–Z and does not rank a version as recommended", () => {
  expect(sortImportedBoards(["v10/board.kicad_pcb", "v9/board.kicad_pcb"], "path")).toEqual(["v9/board.kicad_pcb", "v10/board.kicad_pcb"]);
});
test("backup classification preserves candidates without classifying ordinary board names", () => {
  for (const path of ["v1/backups/board.kicad_pcb", "board-backups/copy.kicad_pcb", "archive-old/copy.kicad_pcb"]) expect(isBackupBoard(path)).toBe(true);
  expect(isBackupBoard("backup-controller/board.kicad_pcb")).toBe(true);
  expect(isBackupBoard("controller/board.kicad_pcb")).toBe(false);
});
