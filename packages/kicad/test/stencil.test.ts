import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arcExtentPoints,
  buildSolderStencil,
  checkMesh,
  decodeBinaryStl,
  encodeBinaryStl,
  exportStencil,
  pointInRing,
  stencilPreviewSvg,
} from "../src/stencil";

const SAMPLE = join(import.meta.dir, "fixtures/stencil-sample.kicad_pcb");
const MINI = join(import.meta.dir, "fixtures/mini-two-layer.kicad_pcb");
const LINE_OUTLINE = join(import.meta.dir, "fixtures/stencil-line-outline.kicad_pcb");

describe("buildSolderStencil", () => {
  test("cuts 0805 apertures, skips fine-pitch QFN pads, and matches the board outline", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildSolderStencil(pcb);
    expect(built.side).toBe("F");
    expect(built.pads.map((p) => `${p.ref}.${p.number}`).sort()).toEqual([
      "R1.1",
      "R1.2",
      "U1.1",
      "U1.2",
      "U1.3",
      "U1.4",
    ]);
    expect(built.apertures.map((a) => `${a.ref}.${a.number}`).sort()).toEqual(["R1.1", "R1.2"]);
    expect(built.skipped.every((p) => p.ref === "U1")).toBe(true);
    expect(built.warnings.some((w) => w.code === "fine_pitch")).toBe(true);

    expect(built.board).toMatchObject({ minX: 0, minY: 0, maxX: 20, maxY: 12, widthMm: 20, heightMm: 12 });
    expect(built.plate).toMatchObject({ minX: -5, minY: -5, maxX: 25, maxY: 17, widthMm: 30, heightMm: 22 });

    for (const a of built.apertures) {
      expect(a.width).toBeCloseTo(1.4, 5);
      expect(a.height).toBeCloseTo(0.9, 5);
      expect(pointInRing(a.x, a.y, a.polygon)).toBe(true);
    }
    const r1 = built.pads.find((p) => p.ref === "R1" && p.number === "1");
    expect(r1).toBeDefined();
    expect(r1!.x).toBeCloseTo(5.05, 5);
    expect(r1!.y).toBeCloseTo(6, 5);

    const mesh = checkMesh(built.plateMesh);
    expect(mesh.triangleCount).toBeGreaterThan(20);
    expect(mesh.watertight).toBe(true);
    expect(mesh.unmatchedEdges).toBe(0);
    expect(mesh.bounds.min[0]).toBeCloseTo(built.plate.minX, 4);
    expect(mesh.bounds.min[1]).toBeCloseTo(built.plate.minY, 4);
    expect(mesh.bounds.min[2]).toBeCloseTo(0, 4);
    expect(mesh.bounds.max[0]).toBeCloseTo(built.plate.maxX, 4);
    expect(mesh.bounds.max[1]).toBeCloseTo(built.plate.maxY, 4);
    expect(mesh.bounds.max[2]).toBeCloseTo(0.15, 4);
  });

  test("uses NPTH mounting holes for registration", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildSolderStencil(pcb);
    expect(built.alignmentHoles).toEqual([
      { x: 2, y: 2, diameterMm: 3.2 },
      { x: 18, y: 10, diameterMm: 3.2 },
    ]);
    expect(built.warnings.some((w) => w.code === "no_tooling_holes")).toBe(false);
  });

  test("exports B.Paste when asked and can keep fine-pitch pads", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const bottom = buildSolderStencil(pcb, { side: "B" });
    expect(bottom.pads.map((p) => p.ref)).toEqual(["C1", "C1"]);
    expect(bottom.apertures).toHaveLength(2);
    expect(bottom.warnings.some((w) => w.code === "bottom_view")).toBe(true);

    const keep = buildSolderStencil(pcb, { skipFinePitch: false, minApertureMm: 0.1, apertureOffsetMm: 0 });
    expect(keep.apertures).toHaveLength(6);
    expect(keep.warnings.some((w) => w.code === "fine_pitch")).toBe(false);
  });

  test("warns and sizes from pads when Edge.Cuts is missing", () => {
    const pcb = `(kicad_pcb (version 20241229) (generator "t")
      (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
      (footprint "X:Y" (layer "F.Cu") (at 10 10)
        (property "Reference" "R2")
        (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu" "F.Paste" "F.Mask"))))`;
    const built = buildSolderStencil(pcb, { frameMm: 3 });
    expect(built.warnings.some((w) => w.code === "no_edge_cuts")).toBe(true);
    expect(built.board.widthMm).toBeCloseTo(2, 5);
    expect(built.plate.widthMm).toBeCloseTo(8, 5);
    expect(() => buildSolderStencil(pcb, { includeJig: true })).toThrow(/Edge.Cuts outline/);
  });

  test("sizes the plate and jig pocket from a gr_line / gr_arc outline, not the pads", async () => {
    const pcb = await Bun.file(LINE_OUTLINE).text();
    const built = buildSolderStencil(pcb, { includeJig: true, frameMm: 5 });
    expect(built.warnings.some((w) => w.code === "no_edge_cuts")).toBe(false);
    const pads = built.pads.map((p) => p.x);
    expect(Math.max(...pads) - Math.min(...pads)).toBeLessThan(3);
    expect(built.board.minX).toBeCloseTo(0, 4);
    expect(built.board.minY).toBeCloseTo(0, 4);
    expect(built.board.maxX).toBeCloseTo(45, 3);
    expect(built.board.maxY).toBeCloseTo(30, 4);
    expect(built.plate.widthMm).toBeCloseTo(55, 3);
    const jig = checkMesh(built.jigMesh!);
    expect(jig.bounds.min[0]).toBeLessThan(built.board.minX);
    expect(jig.bounds.max[0]).toBeGreaterThan(built.plate.maxX);
  });
});

describe("arcExtentPoints", () => {
  test("adds the axis extreme an arc sweeps through, in either direction", () => {
    const maxX = (pts: Array<[number, number]>) => Math.max(...pts.map((p) => p[0]));
    expect(maxX(arcExtentPoints([40, 0], [41.650635, 27.5], [40, 30]))).toBeCloseTo(45, 4);
    expect(maxX(arcExtentPoints([40, 30], [41.650635, 27.5], [40, 0]))).toBeCloseTo(45, 4);
    const corner = arcExtentPoints([0, 3], [0.87868, 0.87868], [3, 0]);
    expect(Math.min(...corner.map((p) => p[0]))).toBeCloseTo(0, 4);
    expect(Math.min(...corner.map((p) => p[1]))).toBeCloseTo(0, 4);
  });
});

describe("binary STL", () => {
  test("round-trips and stays watertight", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildSolderStencil(pcb, { includeJig: true });
    const bytes = encodeBinaryStl(built.plateMesh, "test stencil");
    expect(bytes[0]).toBe("t".charCodeAt(0));
    const again = decodeBinaryStl(bytes);
    expect(again.positions.length).toBe(built.plateMesh.positions.length);
    expect(checkMesh(again).watertight).toBe(true);
    expect(built.jigMesh).toBeDefined();
    expect(checkMesh(built.jigMesh!).triangleCount).toBeGreaterThan(10);
  });
});

describe("exportStencil", () => {
  test("writes STL, JSON, markdown and a preview SVG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-stencil-"));
    const summary = await exportStencil({ board: SAMPLE, outDir: dir });
    expect(summary.padCount).toBe(6);
    expect(summary.apertureCount).toBe(2);
    expect(summary.minApertureMm).toBeCloseTo(0.9, 5);
    expect(summary.warnings.some((w) => w.code === "fine_pitch")).toBe(true);
    const stl = decodeBinaryStl(new Uint8Array(await Bun.file(summary.files.stl).arrayBuffer()));
    expect(checkMesh(stl).watertight).toBe(true);
    const json = (await Bun.file(summary.files.json).json()) as { apertureCount: number };
    expect(json.apertureCount).toBe(2);
    const md = await Bun.file(summary.files.markdown).text();
    expect(md).toContain("Apertures cut");
    expect(md).toContain("F.Paste");
    const svg = await Bun.file(summary.files.svg).text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("2 apertures");
  });

  test("works on the mini two-layer fixture", async () => {
    const pcb = await Bun.file(MINI).text();
    const built = buildSolderStencil(pcb, { minApertureMm: 0.2, skipFinePitch: false });
    expect(built.board).toMatchObject({ minX: 100, minY: 95, maxX: 115, maxY: 110 });
    expect(built.apertures).toHaveLength(2);
    expect(built.pads).toHaveLength(2);
    expect(checkMesh(built.plateMesh).watertight).toBe(true);
    expect(stencilPreviewSvg(built)).toContain("F.Paste");
  });
});
