import { describe, expect, test } from "bun:test";
import {
  compareRevisions,
  diffBoards,
  diffSummary,
  overlaySvgs,
  snapshotFromKicadPcb,
  snapshotFromKicadSch,
  snapshotFromNetlist,
} from "../src";
import { NETLIST_FROM, NETLIST_TO, PCB_FROM, PCB_TO, SCH_FROM, SCH_TO } from "./fixtures";

describe("snapshotFromKicadPcb", () => {
  test("reads footprints, nets, segments, and edge cuts", () => {
    const snap = snapshotFromKicadPcb(PCB_FROM);
    expect(snap.components.map((c) => c.ref).sort()).toEqual(["R1", "R2"]);
    expect(snap.components.find((c) => c.ref === "R1")).toMatchObject({
      value: "10k",
      footprint: "Resistor_SMD:R_0603_1608Metric",
      x: 10,
      y: 20,
      layer: "F.Cu",
    });
    expect(snap.nets.map((n) => n.name).sort()).toEqual(["GND", "VCC"]);
    expect(snap.tracks).toHaveLength(1);
    expect(snap.tracks[0]?.net).toBe("VCC");
    expect(snap.outline).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 40 },
    ]);
  });

  test("reads v10 transform placements", () => {
    const c1 = snapshotFromKicadPcb(PCB_TO).components.find((c) => c.ref === "C1");
    expect(c1).toMatchObject({ x: 40, y: 18, value: "100n" });
  });
});

describe("snapshotFromKicadSch", () => {
  test("reads instance symbols and ignores lib_symbols", () => {
    const snap = snapshotFromKicadSch(SCH_FROM);
    expect(snap.components.map((c) => c.ref).sort()).toEqual(["R1", "R2"]);
    expect(snap.components.find((c) => c.ref === "R1")).toMatchObject({
      schX: 50.8,
      schY: 38.1,
      value: "10k",
      libId: "Device:R",
    });
    expect(snap.nets.map((n) => n.name)).toContain("VCC");
    expect(snap.tracks.some((t) => t.layer === "schematic")).toBe(true);
  });
});

describe("snapshotFromNetlist", () => {
  test("reads components, nodes, and optional placements", () => {
    const snap = snapshotFromNetlist({
      ...NETLIST_FROM,
      board: { placements: [{ ref: "R1", position: { x: 1, y: 2 } }] },
    });
    expect(snap.components).toHaveLength(2);
    expect(snap.components.find((c) => c.ref === "R1")).toMatchObject({ x: 1, y: 2, value: "10k" });
    expect(snap.nets.find((n) => n.name === "GND")?.nodes).toEqual([
      { ref: "R1", pin: "1" },
      { ref: "R2", pin: "2" },
    ]);
  });
});

describe("diffBoards", () => {
  test("flags added, removed, moved, value, and net changes", () => {
    const from = snapshotFromKicadPcb(PCB_FROM);
    const to = snapshotFromKicadPcb(PCB_TO);
    const diff = diffBoards(from, to);
    const summary = diffSummary(diff);
    expect(diff.components.added.map((c) => c.ref)).toEqual(["C1"]);
    expect(diff.components.removed.map((c) => c.ref)).toEqual(["R2"]);
    const r1 = diff.components.changed.find((c) => c.ref === "R1");
    expect(r1?.reasons).toEqual(expect.arrayContaining(["moved", "rotated", "value"]));
    expect(r1?.dx).toBeCloseTo(2);
    expect(r1?.dy).toBeCloseTo(4);
    expect(diff.nets.added.map((n) => n.name)).toEqual(["N_NEW"]);
    expect(diff.nets.changed.find((n) => n.name === "VCC")).toBeTruthy();
    expect(summary.tracksAdded).toBe(1);
    expect(summary.tracksRemoved).toBe(1);
  });

  test("treats tiny moves as unchanged", () => {
    const from = snapshotFromKicadPcb(PCB_FROM);
    const nudged = structuredClone(from);
    const r1 = nudged.components.find((c) => c.ref === "R1");
    if (r1?.x !== undefined) r1.x += 0.01;
    const diff = diffBoards(from, nudged);
    expect(diff.components.changed).toEqual([]);
    expect(diff.components.unchanged).toContain("R1");
  });
});

describe("compareRevisions", () => {
  test("merges netlist + KiCad sources and emits visual SVGs", () => {
    const result = compareRevisions(
      { netlistJson: NETLIST_FROM, kicadPcb: PCB_FROM, kicadSch: SCH_FROM },
      { netlistJson: NETLIST_TO, kicadPcb: PCB_TO, kicadSch: SCH_TO },
    );
    expect(result.diff.components.added.map((c) => c.ref)).toEqual(["C1"]);
    expect(result.diff.components.removed.map((c) => c.ref)).toEqual(["R2"]);
    expect(result.pcb.structured).toContain("data-ref=\"C1\"");
    expect(result.pcb.structured).toContain("data-ref=\"R2\"");
    expect(result.schematic.structured).toContain("data-board-diff=\"schematic\"");
    expect(result.text).toContain("Added: C1");
    expect(result.text).toContain("Removed: R2");
  });

  test("overlays two KiCad-style SVGs as red/green layers", () => {
    const from = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="#000" width="10" height="10"/></svg>`;
    const to = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle fill="#111" cx="5" cy="5" r="2"/></svg>`;
    const overlay = overlaySvgs(from, to);
    expect(overlay).toContain("board-diff-removed");
    expect(overlay).toContain("board-diff-added");
    expect(overlay).toContain("#dc2626");
    expect(overlay).toContain("#16a34a");
    const compared = compareRevisions({ pcbSvg: from }, { pcbSvg: to });
    expect(compared.pcb.overlay).toContain("board-diff-added");
    expect(compared.pcb.sideBySide).toContain("data-board-diff=\"side-by-side\"");
  });
});
