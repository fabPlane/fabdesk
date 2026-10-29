import { expect, test } from "bun:test";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { nativeSourceCandidates } from "./native-source-candidates";
test("source candidates stay inside the declared source and exclude saved outputs and siblings", () => {
  const files = ["boards/io/main.kicad_sch", "boards/io/power.kicad_sch", "boards/lcd/main.kicad_sch", "boards/io/exports/old.kicad_sch", "boards/io/.fabdesk/old.kicad_sch", "board.kicad_sch", "board.kicad_pcb"].map(path => ({ path }));
  const membership = { sources: [{ source: { location: "project", directory: "boards/io" } }, { source: { location: "project", directory: "boards/lcd" } }, { source: { location: "project", directory: "." } }] } as ProjectBoardSources;
  expect(nativeSourceCandidates(files, "schematic", "boards/io", membership)).toEqual(["boards/io/main.kicad_sch", "boards/io/power.kicad_sch"]);
  expect(nativeSourceCandidates(files, "schematic", ".", membership)).toEqual(["board.kicad_sch"]);
  expect(nativeSourceCandidates(files, "pcb")).toEqual(["board.kicad_pcb"]);
});
