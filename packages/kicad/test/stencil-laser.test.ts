import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LASER_STENCIL_PRESET_IDS,
  LASER_STENCIL_PRESETS,
  LaserStencilOptionsError,
  buildLaserStencil,
  exportLaserStencil,
  laserFiducials,
  laserStencilDxf,
  laserStencilSvg,
  resolveLaserStencilOptions,
  unionAperturePolygons,
} from "../src/stencil-laser";
import { laserStencilLbrn2 } from "../src/stencil-laser-lbrn2";
import { LASER_STENCIL_UI_PRESETS } from "../../client-core/src/laser-stencil-presets";

const SAMPLE = join(import.meta.dir, "fixtures/stencil-sample.kicad_pcb");

describe("laser stencil presets", () => {
  test("catalog is Mylar default plus Kapton and stainless", () => {
    expect(LASER_STENCIL_PRESET_IDS).toEqual(["mylar-uv", "kapton", "stainless-0.1"]);
    expect(LASER_STENCIL_PRESETS["mylar-uv"].thicknessMm).toBe(0.1);
    expect(LASER_STENCIL_PRESETS["mylar-uv"].material).toMatch(/Mylar|polyester|PET/i);
    expect(LASER_STENCIL_PRESETS["mylar-uv"].software).toEqual(["LightBurn", "EZCAD", "ComMarker Studio"]);
    expect(LASER_STENCIL_PRESETS.kapton.materialFamily).toBe("kapton");
    expect(LASER_STENCIL_PRESETS.kapton.thicknessMm).toBe(0.075);
    expect(LASER_STENCIL_PRESETS["stainless-0.1"].materialFamily).toBe("stainless");
    for (const id of LASER_STENCIL_PRESET_IDS) {
      const backend = LASER_STENCIL_PRESETS[id];
      const ui = LASER_STENCIL_UI_PRESETS[id];
      expect(ui.thicknessMm).toBe(backend.thicknessMm);
      expect(ui.apertureOffsetMm).toBe(backend.apertureOffsetMm);
      expect(ui.kerfMm).toBe(backend.kerfMm);
      expect(ui.alignmentHoleMm).toBe(backend.alignmentHoleMm);
      expect(ui.includeFiducials).toBe(backend.includeFiducials);
      expect(ui.powerPct).toBe(backend.job.powerPct);
      expect(ui.speedMmPerS).toBe(backend.job.speedMmPerS);
      expect(ui.frequencyKhz).toBe(backend.job.frequencyKhz);
      expect(ui.pulseNs).toBe(backend.job.pulseNs);
      expect(ui.passes).toBe(backend.job.passes);
    }
  });

  test("mylar-uv shrinks paste-release plus kerf, skips sub-min apertures, and adds frame fiducials", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "mylar-uv" });
    expect(built.preset.id).toBe("mylar-uv");
    expect(built.preset.machine).toContain("355 nm");
    expect(built.apertureOffsetMm).toBe(0.05);
    expect(built.kerfMm).toBe(0.015);
    expect(built.layout.options.apertureOffsetMm).toBeCloseTo(0.065, 8);
    expect(built.layout.options.minApertureMm).toBe(0.15);
    expect(built.layout.options.thicknessMm).toBe(0.1);
    expect(built.job).toEqual({
      powerPct: 100,
      speedMmPerS: 1200,
      frequencyKhz: 30,
      pulseNs: 1,
      passes: 2,
      lensMm: 150,
    });
    expect(built.frame).toMatchObject({
      minX: -8,
      minY: -8,
      maxX: 28,
      maxY: 20,
      widthMm: 36,
      heightMm: 28,
    });
    expect(built.apertures.map((a) => `${a.ref}.${a.number}`).sort()).toEqual(["R1.1", "R1.2"]);
    expect(built.skipped.every((p) => p.ref === "U1")).toBe(true);
    expect(built.warnings.some((w) => w.code === "small_aperture")).toBe(true);
    for (const a of built.apertures) {
      expect(a.width).toBeCloseTo(1.37, 5);
      expect(a.height).toBeCloseTo(0.87, 5);
    }
    expect(built.fiducials.length).toBeGreaterThanOrEqual(6);
    expect(built.fiducials).toEqual(
      expect.arrayContaining([
        { x: 2, y: 2, diameterMm: 3.2 },
        { x: 18, y: 10, diameterMm: 3.2 },
      ]),
    );
    const frameHoles = built.fiducials.filter((h) => h.x < 0 || h.x > 20 || h.y < 0 || h.y > 12);
    expect(frameHoles).toHaveLength(4);
    expect(built.paths.some((p) => p.layer === "FRAME" && p.kind === "polygon")).toBe(true);
    expect(built.paths.filter((p) => p.layer === "APERTURES")).toHaveLength(2);
    expect(built.paths.filter((p) => p.layer === "FIDUCIALS")).toHaveLength(built.fiducials.length);
  });

  test("kapton uses a thinner film and its own starting-point job", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "kapton" });
    expect(built.preset.material).toMatch(/Kapton|polyimide/i);
    expect(built.layout.options.thicknessMm).toBe(0.075);
    expect(built.apertureOffsetMm).toBe(0.04);
    expect(built.kerfMm).toBe(0.015);
    expect(built.job.speedMmPerS).toBe(1600);
    expect(built.job.passes).toBe(2);
    expect(built.apertures).toHaveLength(2);
  });

  test("stainless-0.1 uses a larger minimum opening and a slower multi-pass job", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "stainless-0.1" });
    expect(built.preset.material).toContain("stainless");
    expect(built.apertureOffsetMm).toBe(0.05);
    expect(built.layout.options.minApertureMm).toBe(0.25);
    expect(built.job.speedMmPerS).toBe(20);
    expect(built.job.passes).toBe(8);
    expect(built.job.frequencyKhz).toBe(40);
    expect(built.apertures).toHaveLength(2);
    expect(built.skipped).toHaveLength(4);
  });

  test("apertureOffsetMm and kerfMm overrides are configurable", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, {
      preset: "mylar-uv",
      apertureOffsetMm: 0,
      kerfMm: 0,
      minApertureMm: 0,
    });
    expect(built.apertures).toHaveLength(6);
    const r1 = built.apertures.find((a) => a.ref === "R1" && a.number === "1");
    expect(r1?.width).toBeCloseTo(1.5, 5);
    expect(r1?.height).toBeCloseTo(1.0, 5);
  });

  test("starting-point job fields are editable overrides", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, {
      preset: "mylar-uv",
      powerPct: 80,
      speedMmPerS: 900,
      frequencyKhz: 25,
      pulseNs: 2,
      passes: 3,
    });
    expect(built.job).toMatchObject({
      powerPct: 80,
      speedMmPerS: 900,
      frequencyKhz: 25,
      pulseNs: 2,
      passes: 3,
    });
  });

  test("includeFiducials false drops frame-corner and NPTH holes", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "mylar-uv", includeFiducials: false });
    expect(built.fiducials).toEqual([]);
    expect(built.paths.filter((p) => p.layer === "FIDUCIALS")).toHaveLength(0);
  });
});

describe("laserFiducials", () => {
  test("always places four frame-corner holes outside the board", () => {
    const plate = { minX: -8, minY: -8, maxX: 28, maxY: 20, widthMm: 36, heightMm: 28 };
    const board = { minX: 0, minY: 0, maxX: 20, maxY: 12, widthMm: 20, heightMm: 12 };
    const holes = laserFiducials(plate, board, [{ x: 2, y: 2, diameterMm: 3.2 }], 3.2);
    expect(holes).toHaveLength(5);
    expect(holes.filter((h) => h.x === 2 && h.y === 2)).toHaveLength(1);
    for (const h of holes.filter((x) => !(x.x === 2 && x.y === 2))) {
      expect(h.x < 0 || h.x > 20 || h.y < 0 || h.y > 12).toBe(true);
      const r = h.diameterMm / 2 + 0.2;
      expect(h.x - r).toBeGreaterThanOrEqual(plate.minX);
      expect(h.x + r).toBeLessThanOrEqual(plate.maxX);
      expect(h.y - r).toBeGreaterThanOrEqual(plate.minY);
      expect(h.y + r).toBeLessThanOrEqual(plate.maxY);
    }
  });

  test("skips frame holes that cannot sit inside the plate", () => {
    const plate = { minX: -8, minY: -8, maxX: 28, maxY: 20, widthMm: 36, heightMm: 28 };
    const board = { minX: 0, minY: 0, maxX: 20, maxY: 12, widthMm: 20, heightMm: 12 };
    const holes = laserFiducials(plate, board, [], 10);
    expect(holes).toEqual([]);
  });

  test("rejects alignmentHoleMm larger than the frame", () => {
    expect(() => resolveLaserStencilOptions({ alignmentHoleMm: 10 })).toThrow(LaserStencilOptionsError);
    expect(() => resolveLaserStencilOptions({ alignmentHoleMm: 10 })).toThrow(/does not fit/);
  });
});

describe("LightBurn / EZCAD cut files", () => {
  test("SVG is millimetre-unit stroke paths with colour layers", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "mylar-uv" });
    const svg = laserStencilSvg(built);
    expect(svg).toContain('width="36.0000mm"');
    expect(svg).toContain('height="28.0000mm"');
    expect(svg).toContain('data-units="mm"');
    expect(svg).toContain('id="APERTURES"');
    expect(svg).toContain('id="FRAME"');
    expect(svg).toContain('id="FIDUCIALS"');
    expect(svg).toContain('stroke="#FF0000"');
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('stroke="#0000FF"');
    expect(svg).toContain('fill="none"');
    expect(svg).not.toContain('fill="#111"');
  });

  test("DXF is R12 millimetres with closed polylines and fiducial circles", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "mylar-uv" });
    const dxf = laserStencilDxf(built);
    expect(dxf).toContain("$INSUNITS");
    expect(dxf).toMatch(/70\n4\n/);
    expect(dxf).toContain("AC1009");
    expect(dxf).toContain("APERTURES");
    expect(dxf).toContain("FRAME");
    expect(dxf).toContain("FIDUCIALS");
    expect(dxf).toContain("POLYLINE");
    expect(dxf).toContain("CIRCLE");
    expect(dxf).toContain("EOF");
    const first = dxf.indexOf("0\nPOLYLINE");
    const seq = dxf.indexOf("0\nSEQEND", first);
    const block = dxf.slice(first, seq);
    const verts = block.split("0\nVERTEX");
    expect(verts.length).toBeGreaterThan(3);
    const pairs = [...block.matchAll(/\n10\n([0-9.-]+)\n20\n([0-9.-]+)/g)].map((m) => `${m[1]},${m[2]}`);
    expect(pairs.length).toBeGreaterThan(2);
    expect(pairs[0]).not.toBe(pairs.at(-1));
    const circles = dxf.split("\n").filter((l) => l === "CIRCLE");
    expect(circles.length).toBe(built.fiducials.length);
  });

  test("lbrn2 embeds starting-point cut settings and layered geometry", async () => {
    const pcb = await Bun.file(SAMPLE).text();
    const built = buildLaserStencil(pcb, { preset: "mylar-uv", powerPct: 85, passes: 3 });
    const lbrn2 = laserStencilLbrn2(built);
    expect(lbrn2).toContain("<LightBurnProject");
    expect(lbrn2).toContain('MaterialHeight="0.1"');
    expect(lbrn2).toContain("<name Value=\"APERTURES\"/>");
    expect(lbrn2).toContain("<name Value=\"FRAME\"/>");
    expect(lbrn2).toContain("<name Value=\"FIDUCIALS\"/>");
    expect(lbrn2).toContain("<name Value=\"GUIDE\"/>");
    expect(lbrn2).toContain("<maxPower Value=\"85\"/>");
    expect(lbrn2).toContain("<speed Value=\"1200\"/>");
    expect(lbrn2).toContain("<frequency Value=\"30000\"/>");
    expect(lbrn2).toContain("<numPasses Value=\"3\"/>");
    expect(lbrn2).toContain("<QPulseWidth Value=\"1\"/>");
    expect(lbrn2).not.toContain("<pulseWidth ");
    expect(lbrn2).toContain("<doOutput Value=\"0\"/>");
    expect(lbrn2).toContain('Type="Path"');
    expect(lbrn2).toContain('Type="Ellipse"');
    expect(lbrn2).toContain("<VertList>");
    expect(lbrn2).toContain("<PrimList>");
    expect(lbrn2).toMatch(/Starting-point job/i);
  });
});

describe("exportLaserStencil", () => {
  test("writes LightBurn job, SVG, DXF, summary, and starting-point notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-laser-stencil-"));
    const summary = await exportLaserStencil({ board: SAMPLE, outDir: dir, preset: "mylar-uv" });
    expect(summary.preset).toBe("mylar-uv");
    expect(summary.apertureCount).toBe(2);
    expect(summary.fiducialCount).toBeGreaterThanOrEqual(6);
    expect(summary.apertureOffsetMm).toBe(0.05);
    expect(summary.kerfMm).toBe(0.015);
    expect(summary.job.powerPct).toBe(100);
    expect(summary.files.lbrn2).toContain("F-Paste-laser.lbrn2");
    expect(summary.files.svg).toContain("F-Paste-laser.svg");
    expect(await Bun.file(summary.files.lbrn2).exists()).toBe(true);
    expect(await Bun.file(summary.files.svg).exists()).toBe(true);
    expect(await Bun.file(summary.files.dxf).exists()).toBe(true);
    const md = await Bun.file(summary.files.markdown).text();
    expect(md).toContain("LightBurn");
    expect(md).toContain("EZCAD");
    expect(md).toContain("starting-point");
    const notes = await Bun.file(summary.files.notes).text();
    expect(notes).toContain("starting points");
    expect(notes).toContain("355 nm");
    expect(notes).toContain("0.1 mm");
    expect(notes).toContain("1200");
    expect(notes).toMatch(/Starting-point|starting point/i);
    expect(notes).toContain("when they fit");
    expect(notes).not.toContain("Four holes sit");
  });
});

describe("laser stencil path union and fiducials", () => {
  test("overlapping paste records become one cut path", () => {
    const rings = unionAperturePolygons([
      {
        ref: "USB",
        number: "1",
        x: 0,
        y: 0,
        width: 2,
        height: 1,
        polygon: [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
        ],
      },
      {
        ref: "USB",
        number: "2",
        x: 1,
        y: 0,
        width: 2,
        height: 1,
        polygon: [
          [1, 0],
          [3, 0],
          [3, 1],
          [1, 1],
        ],
      },
    ]);
    expect(rings).toHaveLength(1);
    const xs = rings[0]!.map(([x]) => x);
    const ys = rings[0]!.map(([, y]) => y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(3, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
  });

  test("boards without NPTH get four frame holes, not a second fallback set", async () => {
    const pcb = (await Bun.file(SAMPLE).text()).replace(
      /\(footprint "MountingHole:MountingHole_3\.2mm"[\s\S]*?\n\t\)\n/g,
      "",
    );
    const built = buildLaserStencil(pcb, { preset: "mylar-uv" });
    expect(built.fiducials).toHaveLength(4);
    expect(built.paths.filter((p) => p.layer === "FIDUCIALS")).toHaveLength(4);
  });
});
