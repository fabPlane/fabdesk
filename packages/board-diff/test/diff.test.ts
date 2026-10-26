import { describe, expect, test } from "bun:test";
import {
  compareRevisions,
  diffBoards,
  diffSummary,
  emptySnapshot,
  flattenArc,
  overlaySvgs,
  parseViewBox,
  snapshotFromKicadPcb,
  snapshotFromKicadSch,
  snapshotFromNetlist,
  snapshotSvg,
  visualDiffSvg,
} from "../src";
import {
  NETLIST_FROM,
  NETLIST_TO,
  PCB_COPPER_FROM,
  PCB_COPPER_TO,
  PCB_FROM,
  PCB_NO_R1,
  PCB_PAD_GEOMETRY,
  PCB_TO,
  SCH_FROM,
  SCH_R1_MOVED,
  SCH_TO,
} from "./fixtures";

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

  test("reads vias, flattened arcs, zones, and pad geometry", () => {
    const snap = snapshotFromKicadPcb(PCB_COPPER_FROM);
    expect(snap.vias).toHaveLength(2);
    expect(snap.vias.find((v) => v.x === 25 && v.y === 20)).toMatchObject({
      diameter: 0.8,
      drill: 0.4,
      net: "GND",
    });
    expect(snap.zones).toHaveLength(1);
    expect(snap.zones[0]).toMatchObject({ net: "GND", layers: ["F.Cu"] });
    expect(snap.zones[0]?.points).toHaveLength(4);
    expect(snap.tracks.some((t) => t.points && t.points.length > 2)).toBe(true);
    const r1 = snapshotFromKicadPcb(PCB_FROM).components.find((c) => c.ref === "R1");
    expect(r1?.pads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pin: "1", shape: "rect", width: 0.9, height: 0.95, net: "GND" }),
      ]),
    );
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

  test("treats loss of PCB placement as removed", () => {
    const from = snapshotFromKicadPcb(PCB_FROM);
    const to = snapshotFromNetlist(NETLIST_FROM);
    const diff = diffBoards(from, to);
    expect(diff.components.removed.map((c) => c.ref).sort()).toEqual(["R1", "R2"]);
    expect(diff.components.unchanged).toEqual([]);
  });

  test("flags pad size, shape, drill, and count changes", () => {
    const from = snapshotFromKicadPcb(PCB_FROM);
    const to = snapshotFromKicadPcb(PCB_PAD_GEOMETRY);
    const r1 = diffBoards(from, to).components.changed.find((c) => c.ref === "R1");
    expect(r1?.reasons).toEqual(["pads"]);
    expect(to.components.find((c) => c.ref === "R1")?.pads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pin: "1", shape: "circle", width: 1.2, drill: 0.4 }),
        expect.objectContaining({ pin: "2", width: 1.1, height: 1.15 }),
      ]),
    );
  });

  test("reports moved, added, and removed vias plus zone reshape and arc copper", () => {
    const from = snapshotFromKicadPcb(PCB_COPPER_FROM);
    const to = snapshotFromKicadPcb(PCB_COPPER_TO);
    const diff = diffBoards(from, to);
    expect(diff.vias.changed.some((c) => c.reasons.includes("moved") && c.before.x === 25)).toBe(true);
    expect(diff.vias.removed.some((v) => v.x === 8 && v.y === 8)).toBe(true);
    expect(diff.vias.added.some((v) => v.x === 40 && v.y === 30)).toBe(true);
    expect(diff.zones.changed).toHaveLength(1);
    expect(diff.zones.changed[0]?.reasons).toContain("reshaped");
    expect(diff.tracks.added.length).toBe(1);
    expect(diff.tracks.removed.length).toBe(1);
    expect(diffSummary(diff)).toMatchObject({ viasChanged: 1, viasAdded: 1, viasRemoved: 1, zonesChanged: 1 });
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

  test("a schematic-only move and rotation is a schematic change, not a PCB one", () => {
    expect(SCH_R1_MOVED).not.toBe(SCH_FROM);
    const result = compareRevisions(
      { kicadPcb: PCB_FROM, kicadSch: SCH_FROM },
      { kicadPcb: PCB_FROM, kicadSch: SCH_R1_MOVED },
    );
    const r1 = result.diff.components.changed.find((c) => c.ref === "R1");
    expect(r1?.reasons).toEqual(["schematic-moved", "schematic-rotated"]);
    expect(r1?.schDx).toBeCloseTo(10.16);
    expect(r1?.schDy).toBeCloseTo(0);
    expect(r1?.dx).toBeUndefined();
    expect(result.diff.components.unchanged).toEqual(["R2"]);
    expect(diffSummary(result.diff)).toMatchObject({ moved: 0, schematicMoved: 1, changed: 1 });
    expect(result.text).toContain("R1 (schematic-moved, schematic-rotated)");

    const amberR1 = /data-ref="R1"[^>]*>\s*<rect[^>]*stroke="#d97706"/;
    expect(result.schematic.structured).toMatch(amberR1);
    expect(result.schematic.structured).toContain('marker-end="url(#board-diff-arrow)"');
    expect(result.pcb.structured).not.toMatch(amberR1);
    expect(result.pcb.structured).not.toContain('marker-end="url(#board-diff-arrow)"');
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

  test("overlay recolors geometry without turning revision backgrounds into solid color layers", () => {
    const result = compareRevisions({ kicadPcb: PCB_FROM }, { kicadPcb: PCB_TO });
    expect(result.pcb.sideBySide.match(/data-board-diff-background="true"/g)).toHaveLength(2);
    expect(result.pcb.overlay).not.toContain('data-board-diff-background="true"');
    expect(result.pcb.overlay).toContain('stroke="#dc2626"');
    expect(result.pcb.overlay).toContain('stroke="#16a34a"');
    expect(result.pcb.overlay).toContain('fill="#ffffff"');
  });

  test("native comparisons ignore asymmetric or stale saved renders on both surfaces", () => {
    const before = { kicadPcb: PCB_FROM, kicadSch: SCH_FROM };
    const after = { kicadPcb: PCB_TO, kicadSch: SCH_TO };
    const stale = '<svg viewBox="0 0 999 999"><text>STALE ARTWORK</text></svg>';
    const expected = compareRevisions(before, after);
    for (const [from, to] of [
      [before, { ...after, pcbSvg: stale, schematicSvg: stale }],
      [{ ...before, pcbSvg: stale, schematicSvg: stale }, after],
      [{ ...before, pcbSvg: stale, schematicSvg: stale }, { ...after, pcbSvg: stale, schematicSvg: stale }],
    ]) {
      const actual = compareRevisions(from!, to!);
      for (const surface of ["pcb", "schematic"] as const) {
        expect(actual[surface].overlay).toBe(expected[surface].overlay);
        expect(actual[surface].sideBySide).toBe(expected[surface].sideBySide);
        expect(actual[surface].sideBySide).not.toContain("STALE ARTWORK");
      }
    }
  });

  test("PCB without R1 plus a stale netlist that still has R1 treats R1 as removed", () => {
    const result = compareRevisions(
      { netlistJson: NETLIST_FROM, kicadPcb: PCB_FROM },
      { netlistJson: NETLIST_FROM, kicadPcb: PCB_NO_R1 },
    );
    expect(result.to.components.map((c) => c.ref)).toEqual(["R2"]);
    expect(result.diff.components.removed.map((c) => c.ref)).toEqual(["R1"]);
    expect(result.diff.components.unchanged).toEqual(["R2"]);
    expect(result.to.nets.find((n) => n.name === "GND")?.nodes.map((n) => n.ref)).toEqual(["R2"]);
  });

  test("stale netlist does not hide PCB pad net membership", () => {
    const result = compareRevisions(
      { netlistJson: NETLIST_FROM, kicadPcb: PCB_FROM },
      { netlistJson: NETLIST_FROM, kicadPcb: PCB_TO },
    );
    expect(result.diff.components.removed.map((c) => c.ref)).toEqual(["R2"]);
    expect(result.diff.nets.changed.find((n) => n.name === "VCC")).toBeTruthy();
    expect(result.to.nets.find((n) => n.name === "N_NEW")?.nodes.map((n) => `${n.ref}.${n.pin}`)).toEqual(
      expect.arrayContaining(["R1.2", "C1.1"]),
    );
  });

  test("prefixes colliding SVG ids in overlay layers", () => {
    const from = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/></svg>`;
    const to = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="1"/></linearGradient></defs><circle fill="url(#g)" cx="5" cy="5" r="2"/></svg>`;
    const overlay = overlaySvgs(from, to);
    expect(overlay).toContain('id="removed-g"');
    expect(overlay).toContain('id="added-g"');
    expect(overlay).toContain("url(#removed-g)");
    expect(overlay).toContain("url(#added-g)");
    expect(overlay).not.toMatch(/id="g"/);
    expect(overlay).not.toMatch(/url\(#g\)/);
  });

  test("empty boards keep a finite 100x80 viewBox (the #239 infinite-bounds case does not apply)", () => {
    const empty = emptySnapshot();
    const diff = diffBoards(empty, empty);
    const structured = visualDiffSvg(empty, empty, diff, "pcb");
    const overlay = overlaySvgs(snapshotSvg(empty, "pcb"), snapshotSvg(empty, "pcb"));
    const compared = compareRevisions({}, {});
    for (const svg of [structured, overlay, compared.pcb.structured, compared.pcb.overlay, snapshotSvg(empty)]) {
      const box = parseViewBox(svg);
      expect(box).toBeDefined();
      expect([box!.x, box!.y, box!.w, box!.h].every(Number.isFinite)).toBe(true);
      expect(box!.w).toBeGreaterThan(0);
      expect(box!.h).toBeGreaterThan(0);
    }
  });
});

describe("flattenArc", () => {
  test("returns a polyline through start/mid/end", () => {
    const pts = flattenArc({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 });
    expect(pts.length).toBeGreaterThan(2);
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[0]!.y).toBeCloseTo(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(2);
    expect(pts[pts.length - 1]!.y).toBeCloseTo(0);
    expect(pts.some((p) => p.y > 0.5)).toBe(true);
  });
});
