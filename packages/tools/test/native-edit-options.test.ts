/** pcb_edit_copper's local DRC, the mounting-hole keepout preset, and board-note options (fabdesk#32). */
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type CoreServices, type PcbGeometryEdit } from "../src";
import { estimateNoteBox, mountingHoleKeepout, normalizeNoteText } from "../src/tools/native-edit";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function harness(name: string, overrides: (base: CoreServices, board: string) => Partial<CoreServices>) {
  const reg = createRegistry();
  const project = await tempProject(name);
  const board = join(project.dir, "board.kicad_pcb");
  await writeFile(board, "(kicad_pcb before)\n");
  const base = mockServices([project]);
  const services = mockServices([project], overrides(base, board));
  const factory = contextFactory(services, project);
  const call = (tool: string, args: Record<string, unknown>) =>
    reg.invoke(tool, args, (ref) =>
      factory({ def: reg.get(tool)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }),
    );
  return { project, board, call };
}

const violation = (type: string, severity: string, excluded = false) => ({
  type,
  severity,
  description: `${type} here`,
  excluded,
  items: [{ description: "Track [GND] on F.Cu", pos: { x: 1, y: 2 }, uuid: `id-${type}` }],
});

describe("pcb_edit_copper checkDrc", () => {
  const drcHarness = (raw: Record<string, unknown>, severities: string[]) =>
    harness(`copper-drc-${severities.length}-${Math.random().toString(36).slice(2, 6)}`, (base, board) => ({
      design: {
        ...base.design,
        editBoardGeometry: async (dir, edit) => {
          await writeFile(board, "(kicad_pcb after)\n");
          return base.design.editBoardGeometry(dir, edit);
        },
      },
      kicad: {
        ...base.kicad,
        runDrc: async (_cli, opts) => {
          severities.push(String(opts.severity));
          await writeFile(opts.outFile, JSON.stringify(raw));
          return { violations: [], unconnected: [], schematicParity: [], counts: { errors: 99, warnings: 0, unconnected: 0 } };
        },
      },
    }));
  const track = { start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.2, layer: "F.Cu", net: "GND" };

  test("uses project severity and reports opens apart from errors", async () => {
    const severities: string[] = [];
    const { project, call } = await drcHarness(
      {
        violations: [violation("clearance", "error", true), violation("silk_overlap", "warning")],
        unconnected_items: [violation("unconnected_items", "error"), violation("unconnected_items", "error")],
      },
      severities,
    );
    const result = await call("pcb_edit_copper", { tracks: [track], checkDrc: true });
    expect(severities).toEqual(["project"]);
    // An intermediate open is not a DRC error, and the owner-excluded clearance item is dropped.
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("0 error(s), 1 warning(s)");
    expect(result.text).toContain("2 unconnected item(s) remain; these are opens, not DRC errors");
    const drc = (result.json as any).drc;
    expect(drc.severity).toBe("project");
    expect(drc.counts).toEqual({ errors: 0, warnings: 1, unconnected: 2 });
    expect(drc.errors).toEqual([]);
    expect(drc.opens).toHaveLength(2);
    expect(drc.path).toBe("reports/copper-drc.json");
    const saved = JSON.parse(await readFile(join(project.dir, "reports/copper-drc.json"), "utf8"));
    expect(saved.counts.unconnected).toBe(2);
    expect(saved.raw).toBeUndefined();
  });

  test("a live DRC error makes the result an error but leaves the edit saved", async () => {
    const severities: string[] = [];
    const { board, call } = await drcHarness({ violations: [violation("clearance", "error")], unconnected_items: [] }, severities);
    const result = await call("pcb_edit_copper", { tracks: [track], checkDrc: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("1 error(s), 0 warning(s)");
    expect(result.text).not.toContain("unconnected");
    expect((result.json as any).drc.errors[0].rule).toBe("clearance");
    expect(await readFile(board, "utf8")).toBe("(kicad_pcb after)\n");
  });

  test("checkDrc still refuses preview", async () => {
    const { call } = await drcHarness({}, []);
    await expect(call("pcb_edit_copper", { mode: "preview", tracks: [track], checkDrc: true })).rejects.toThrow(
      /checkDrc requires mode=apply/,
    );
  });
});

describe("mounting-hole keepout preset", () => {
  const holeRows = {
    components: [{ ref: "H1", x: 5, y: 5 }, { ref: "H10", x: 50, y: 50 }],
    pads: [
      { component: "H1", number: "", x: 5, y: 5, width: 3.2, height: 3.2, layerNames: ["F.Cu", "B.Cu"] },
      { component: "H10", number: "", x: 50, y: 50, width: 9, height: 9, layerNames: ["F.Cu", "B.Cu"] },
    ],
  } as Record<string, Array<Record<string, unknown>>>;
  const holeHarness = (edits: PcbGeometryEdit[]) =>
    harness(`hole-keepout-${Math.random().toString(36).slice(2, 6)}`, (base) => ({
      design: {
        ...base.design,
        query: async (dir, select, filter) => holeRows[select] ?? base.design.query(dir, select, filter),
        editBoardGeometry: async (dir, edit) => {
          edits.push(edit);
          return base.design.editBoardGeometry(dir, edit);
        },
      },
    }));

  test("blocks tracks, vias and pours around the hole but never its own pad or footprint", async () => {
    const edits: PcbGeometryEdit[] = [];
    const { call } = await holeHarness(edits);
    const result = await call("pcb_edit_graphics", { mountingHoleKeepouts: [{ reference: "H1", clearance: 0.5 }] });
    expect((result.json as any).status).toBe("accepted");
    const keepout = edits[0]?.keepouts?.[0];
    expect(keepout).toMatchObject({
      name: "H1 mounting-hole keepout",
      layers: [3, 34],
      tracks: true,
      vias: true,
      copper: true,
      pads: false,
      footprints: false,
    });
    expect(keepout?.points).toHaveLength(32);
    // The polygon circumscribes the 1.6 mm pad radius + 0.5 mm clearance circle, H1 (not H10) sized.
    const radii = keepout!.points.map((point) => Math.hypot(point.x - 5, point.y - 5));
    expect(Math.min(...radii)).toBeGreaterThanOrEqual(2.1);
    expect(Math.max(...radii)).toBeLessThanOrEqual(2.1 / Math.cos(Math.PI / 32) + 1e-6);
    expect((result.json as any).plan.geometry.mountingHoleKeepouts).toHaveLength(1);
  });

  test("a plated hole that must join a pour can let copper in; layers can be narrowed", async () => {
    const keepout = mountingHoleKeepout(
      { reference: "H2", clearance: 0, segments: 8, tracks: true, vias: false, copper: false, layers: ["F.Cu"] },
      { x: 0, y: 0 },
      [{ x: 0, y: 0, width: 6, height: 6 }],
    );
    expect(keepout).toMatchObject({ layers: ["F.Cu"], tracks: true, vias: false, copper: false, pads: false, footprints: false });
    expect(Math.min(...keepout.points.map((p) => Math.hypot(p.x, p.y)))).toBeCloseTo(3 / Math.cos(Math.PI / 8), 5);
  });

  test("unknown references, padless footprints and same-transaction moves are refused", async () => {
    const edits: PcbGeometryEdit[] = [];
    const { call } = await holeHarness(edits);
    await expect(call("pcb_edit_graphics", { mountingHoleKeepouts: [{ reference: "H9", clearance: 1 }] })).rejects.toThrow(
      /unknown PCB footprint H9/,
    );
    expect(() =>
      mountingHoleKeepout({ reference: "H3", clearance: 1, segments: 32, tracks: true, vias: true, copper: true }, { x: 0, y: 0 }, []),
    ).toThrow(/no pads/);
    await expect(
      call("native_edit_transaction", {
        mode: "apply",
        footprints: [{ reference: "H1", position: { x: 1, y: 1 } }],
        geometry: { mountingHoleKeepouts: [{ reference: "H1", clearance: 1 }] },
      }),
    ).rejects.toThrow(/cannot be combined with moving the same footprint/);
    expect(edits).toEqual([]);
  });
});

describe("board notes", () => {
  const outline = [{ minX: 0, minY: 0, maxX: 20, maxY: 20, widthMm: 20, heightMm: 20 }];
  const noteHarness = (edits: PcbGeometryEdit[], rows: Array<Record<string, unknown>> = outline) =>
    harness(`board-notes-${Math.random().toString(36).slice(2, 6)}`, (base) => ({
      design: {
        ...base.design,
        query: async (dir, select, filter) => (select === "outline" ? rows : base.design.query(dir, select, filter)),
        editBoardGeometry: async (dir, edit) => {
          edits.push(edit);
          return base.design.editBoardGeometry(dir, edit);
        },
      },
    }));

  test("alignment passes through and a literal \\n becomes a line break", async () => {
    const edits: PcbGeometryEdit[] = [];
    const { call } = await noteHarness(edits);
    const result = await call("pcb_edit_graphics", {
      texts: [{ text: "REV A\\nfabPlane", position: { x: 2, y: 10 }, layer: "F.SilkS", align: "left" }],
    });
    expect(edits[0]?.texts?.[0]).toMatchObject({ text: "REV A\nfabPlane", align: "left", layer: 40 });
    expect((result.json as any).warnings).toBeUndefined();
    expect(result.text).not.toContain("Warning");
  });

  test("a note that leaves the outline is applied with a warning, in preview and apply", async () => {
    const edits: PcbGeometryEdit[] = [];
    const { call } = await noteHarness(edits);
    const texts = [
      { text: "M3 HOLES", position: { x: 19, y: 10 }, layer: "F.SilkS" },
      { text: "OK", position: { x: 10, y: 10 }, layer: "F.SilkS" },
    ];
    const preview = await call("pcb_edit_graphics", { mode: "preview", texts });
    expect((preview.json as any).warnings).toHaveLength(1);
    expect((preview.json as any).warnings[0]).toMatch(/Board note 1 "M3 HOLES" extends outside the board outline/);
    expect(edits).toEqual([]);
    const applied = await call("pcb_edit_graphics", { texts });
    expect((applied.json as any).status).toBe("accepted");
    expect(applied.text).toContain("Warning: Board note 1");
    expect(edits[0]?.texts).toHaveLength(2);
    // Right-aligned at the right edge's inside keeps it on the board.
    const fixed = await call("pcb_edit_graphics", { texts: [{ ...texts[0]!, align: "right" }] });
    expect((fixed.json as any).warnings).toBeUndefined();
  });

  test("an outline replaced in the same transaction is the one notes are checked against", async () => {
    const { call } = await noteHarness([]);
    const result = await call("pcb_edit_graphics", {
      mode: "preview",
      outline: { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], replace: true },
      texts: [{ text: "OK", position: { x: 10, y: 10 }, layer: "F.SilkS" }],
    });
    expect((result.json as any).warnings).toHaveLength(1);
  });

  test("a board without an outline says the notes were not bounds-checked", async () => {
    const { call } = await noteHarness([], []);
    const result = await call("pcb_edit_graphics", {
      mode: "preview",
      texts: [{ text: "X", position: { x: 1, y: 1 }, layer: "F.SilkS" }],
    });
    expect((result.json as any).warnings[0]).toMatch(/not bounds-checked/);
  });

  test("estimated box follows alignment, line count and rotation", () => {
    const base = { text: "ABCD", position: { x: 10, y: 10 }, size: { x: 1, y: 1 }, thickness: 0.1 };
    const centre = estimateNoteBox(base);
    expect(centre.minX).toBeCloseTo(10 - 1.85, 6);
    expect(centre.maxX).toBeCloseTo(10 + 1.85, 6);
    const left = estimateNoteBox({ ...base, align: "left" });
    expect(left.minX).toBeCloseTo(9.95, 6);
    expect(left.maxX).toBeCloseTo(13.65, 6);
    const right = estimateNoteBox({ ...base, align: "right" });
    expect(right.maxX).toBeCloseTo(10.05, 6);
    const twoLines = estimateNoteBox({ ...base, text: normalizeNoteText("AB\r\nCD") });
    expect(twoLines.maxY - twoLines.minY).toBeCloseTo(1 + 1.62 + 0.1, 6);
    // Rotated 90 degrees counter-clockwise, a left-aligned line runs up the board (towards smaller y).
    const up = estimateNoteBox({ ...base, align: "left", angle: 90 });
    expect(up.maxY).toBeCloseTo(10.05, 6);
    expect(up.minY).toBeCloseTo(10 - 3.65, 6);
  });
});
