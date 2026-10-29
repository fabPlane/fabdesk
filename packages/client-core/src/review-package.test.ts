import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { reviewPackageFiles } from "./review-package";
const file = (path: string) => ({ path, size: 10, mtime: "2026-10-29T00:00:00Z" });
const options = { outputs: true, sources: true, notes: true, checks: true };
const single = ProjectBoardSources.parse({ projectId: "p", mode: "single", assembly: null, manifestSha256: null, sources: [], observedAt: "2026-10-29T00:00:00Z", editing: "single-board-only" });
test("review packages include intended design files and omit secrets, logs and caches", () => {
  const files = ["fabdesk.json", "board.kicad_pcb", "sheets/child.kicad_sch", "exports/product-video.mp4", "NOTES.md", "reports/drc.json", ".env", ".git/config", ".fabdesk/runs/private.json", ".fabdesk/backup/board.kicad_pcb", "settings.json", "reports/agent-dump.json", "../secret"].map(file);
  expect(reviewPackageFiles(files, single, options).map(file => file.path)).toEqual(["board.kicad_pcb", "exports/product-video.mp4", "fabdesk.json", "NOTES.md", "reports/drc.json", "sheets/child.kicad_sch"]);
  expect(reviewPackageFiles(files, single, { outputs: false, sources: false, notes: false, checks: false }).map(file => file.path)).toEqual(["fabdesk.json"]);
});
test("assembly packages do not infer root or undeclared/blocked member ownership", () => {
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" }, nested = { ...source, id: "blocked", directory: "boards/io/blocked" };
  const scope = ProjectBoardSources.parse({ ...single, mode: "assembly", manifestSha256: "a".repeat(64), assembly: { contract: "fabplane.assembly.v1", sources: [source, nested], instances: [{ id: "io-1", name: "I/O", sourceId: "io" }], connections: [] }, sources: [{ source, status: "available" }, { source: nested, status: "blocked" }] });
  const files = ["fabplane.assembly.json", "board.kicad_pcb", "boards/io/board.kicad_pcb", "boards/io/renders/top.png", "boards/io/blocked/board.kicad_pcb", "boards/io/blocked/renders/top.png", "boards/other/board.kicad_pcb"].map(file);
  expect(reviewPackageFiles(files, scope, options).map(file => file.path)).toEqual(["boards/io/board.kicad_pcb", "boards/io/renders/top.png", "fabplane.assembly.json"]);
});
