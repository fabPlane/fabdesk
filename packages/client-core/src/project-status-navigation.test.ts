import { expect, test } from "bun:test";
import { ProjectBoardSources, type SharedBoard } from "@fabdesk/protocol";
import { captureAssemblySelection } from "./assembly-scene";
import { projectStatusIsEmpty, projectStatusTarget } from "./project-status-navigation";

const source = { id: "io", name: "I/O", location: "project", directory: "." };
const board: SharedBoard = { id: "io", name: "I/O", sourceAvailable: true, sourceState: "pcb", checks: { state: "no-report", findingCount: null }, preview: null };
const data = () => ProjectBoardSources.parse({ projectId: "project", mode: "single", manifestSha256: null, editing: "single-board-only", observedAt: "2026-11-16T00:00:00Z", assembly: null, sources: [{ source, status: "available", pcbPath: "board.kicad_pcb" }] });

test("a schematic-only root opens the schematic while PCB-only actions remain unavailable", () => {
  const sources = data(); sources.sources[0]!.status = "missing";
  const schematic: SharedBoard = { ...board, sourceAvailable: false, sourceState: "schematic-only" };
  expect(projectStatusTarget("project", schematic, sources, "design")).toEqual({ tab: "schematic", selection: null });
  expect(projectStatusTarget("project", schematic, sources, "drc")).toBeNull();
  expect(projectStatusTarget("project", schematic, sources, "3d")).toBeNull();
  expect(projectStatusTarget("other", schematic, sources, "design")).toBeNull();
});

test("status navigation preserves the selected repeated physical instance", () => {
  const sources = data(); sources.mode = "assembly"; sources.manifestSha256 = "a".repeat(64);
  sources.assembly = { contract: "fabplane.assembly.v1", sources: [{ ...source, location: "project" }], instances: [{ id: "left", name: "Left", sourceId: "io" }, { id: "right", name: "Right", sourceId: "io" }], connections: [] };
  const selected = captureAssemblySelection(sources, "right")!;
  expect(projectStatusTarget("project", board, sources, "design", selected)).toEqual({ tab: "pcb", selection: selected });
  expect(projectStatusTarget("project", board, sources, "drc", selected)?.selection).toEqual(selected);
  expect(projectStatusTarget("project", board, sources, "3d", selected)?.selection).toEqual(selected);
  sources.sources[0]!.status = "missing";
  expect(projectStatusTarget("project", board, sources, "design", selected)).toBeNull();
});

test("unavailable or unrelated sources cannot be opened from stale status rows", () => {
  const sources = data();
  expect(projectStatusTarget("project", board, sources, "design")?.tab).toBe("pcb");
  expect(projectStatusTarget("project", { ...board, id: "unknown" }, sources, "design")).toBeNull();
  expect(projectStatusTarget("project", { ...board, sourceAvailable: false, sourceState: "missing" }, sources, "design")).toBeNull();
  sources.sources[0]!.status = "blocked";
  expect(projectStatusTarget("project", board, sources, "design")).toBeNull();
  expect(projectStatusTarget("project", { ...board, sourceAvailable: false, sourceState: "schematic-only" }, sources, "design")).toBeNull();
});

test("only fresh single-board projects use the empty status", () => {
  const fresh = [{ path: "project.json" }, { path: "notes.md" }, { path: "sketches/idea.png" }];
  expect(projectStatusIsEmpty(fresh, "single")).toBe(true);
  expect(projectStatusIsEmpty(fresh, "assembly")).toBe(false);
  expect(projectStatusIsEmpty([...fresh, { path: "board.kicad_sch" }], "single")).toBe(false);
  expect(projectStatusIsEmpty([...fresh, { path: "hardware/io/board.kicad_pcb" }], "single")).toBe(false);
});

test("removing a board source preserves missing-source status while evidence remains", () => {
  for (const artifact of ["renders/board.glb", "renders/board.glb.revision.json", "renders/pcb.svg", "renders/schematic.svg", "reports/drc.json", "reports/erc.rpt", "hardware\\io\\renders\\board.glb"]) {
    const source = { path: "board.kicad_pcb" };
    const files = [source, { path: artifact }];
    expect(projectStatusIsEmpty(files, "single")).toBe(false);
    expect(projectStatusIsEmpty(files.filter(file => file !== source), "single")).toBe(false);
  }
});

test("refreshed file metadata determines whether a project is still empty", () => {
  const files = [{ path: "project.json" }];
  expect(projectStatusIsEmpty(files, "single")).toBe(true);
  const withReport = [...files, { path: "reports/drc.json" }];
  expect(projectStatusIsEmpty(withReport, "single")).toBe(false);
  expect(projectStatusIsEmpty(files, "single")).toBe(true);
});
