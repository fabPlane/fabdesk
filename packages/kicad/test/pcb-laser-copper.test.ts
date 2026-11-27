import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CopperLaserOptionsError,
  buildCopperLaserJob,
  copperLaserLbrn2,
  copperLaserSvg,
  exportCopperLaserJob,
  suggestCopperPreset,
} from "../src/pcb-laser-copper";

/** 40 × 30 mm board: two 1.6 × 1.6 pads on a 0.3 mm track, a through-hole pad and a via. */
const BOARD = `(kicad_pcb (version 20240108) (generator "test")
  (gr_rect (start 100 100) (end 140 130) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  (footprint "R" (layer "F.Cu") (at 110 115 90)
    (pad "1" smd rect (at -2 0 90) (size 1.6 1.6) (layers "F.Cu" "F.Paste" "F.Mask"))
    (pad "2" smd roundrect (at 2 0 90) (size 1.6 1.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25)))
  (footprint "J" (layer "F.Cu") (at 130 115)
    (pad "1" thru_hole circle (at 0 0) (size 1.8 1.8) (drill 1) (layers "*.Cu" "*.Mask")))
  (segment (start 110 113) (end 130 115) (width 0.3) (layer "F.Cu") (net 1))
  (segment (start 110 117) (end 120 125) (width 0.3) (layer "B.Cu") (net 2))
  (via (at 120 125) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2))
)`;

describe("copper laser job", () => {
  test("isolation removes a ring around copper and never the copper itself", () => {
    const job = buildCopperLaserJob(BOARD, { isolationMm: 0.4 });
    expect(job.board.widthMm).toBe(40);
    expect(job.counts).toMatchObject({ tracks: 1, pads: 3, vias: 1 });
    expect(job.preset).toBe("omni-x-6w-70mm");
    expect(job.areaMm2.copper).toBeGreaterThan(5);
    // The ring is far smaller than full ablation of the 1200 mm² board.
    expect(job.areaMm2.ablate).toBeGreaterThan(5);
    expect(job.areaMm2.ablate).toBeLessThan(200);
    // A point on the track stays copper (not ablated); a point 0.3 mm beside it is ablated.
    const inside = (mp: typeof job.ablate, [x, y]: [number, number]) =>
      mp.some(poly => {
        const hit = (ring: number[][]) => {
          let c = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
            if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) c = !c;
          }
          return c;
        };
        return hit(poly[0]!) && !poly.slice(1).some(hit);
      });
    // Track from (110,113) to (130,115): midpoint (120,114) → job (20, 16) since Y flips around maxY = 130.
    expect(inside(job.ablate, [20, 16])).toBe(false);
    expect(inside(job.copper, [20, 16])).toBe(true);
    expect(inside(job.ablate, [20, 16.45])).toBe(true);
    // Far from copper nothing is removed in isolation mode.
    expect(inside(job.ablate, [5, 5])).toBe(false);
  });

  test("full mode clears the whole board except copper, with a drill dot in the through-hole pad", () => {
    const job = buildCopperLaserJob(BOARD, { mode: "full", drillMarkMm: 0.4 });
    expect(job.areaMm2.ablate).toBeGreaterThan(1150);
    expect(job.areaMm2.ablate + job.areaMm2.copper).toBeCloseTo(1200, 0);
    expect(job.drills.filter(d => d.kind === "pad")).toHaveLength(1);
  });

  test("bottom copper is mirrored by default", () => {
    const top = buildCopperLaserJob(BOARD, { side: "F" });
    const bottom = buildCopperLaserJob(BOARD, { side: "B" });
    expect(top.mirror).toBe(false);
    expect(bottom.mirror).toBe(true);
    expect(bottom.counts.tracks).toBe(1);
    // The via at board x = 120 sits at job x = 20 unmirrored and 40 - 20 = 20 mirrored; the THT pad at 130 moves 30 → 10.
    expect(top.drills.find(d => d.kind === "pad")!.x).toBeCloseTo(30);
    expect(bottom.drills.find(d => d.kind === "pad")!.x).toBeCloseTo(10);
  });

  test("lens preset follows board size", () => {
    expect(suggestCopperPreset(60, 40)).toBe("omni-x-6w-70mm");
    expect(suggestCopperPreset(90, 55)).toBe("omni-x-6w-150mm");
  });

  test("rejects boards without an outline and bad settings", () => {
    expect(() => buildCopperLaserJob(BOARD.replace(/\(gr_rect[^\n]+\n/, ""))).toThrow(CopperLaserOptionsError);
    expect(() => buildCopperLaserJob(BOARD, { settings: { ablate: { powerPct: 120 } } })).toThrow("power");
  });

  test("LightBurn and SVG writers", () => {
    const job = buildCopperLaserJob(BOARD);
    const lbrn = copperLaserLbrn2(job);
    expect(lbrn).toContain('<CutSetting type="Scan">');
    expect(lbrn).toContain('<name Value="ABLATE"/>');
    expect(lbrn).toContain('<crossHatch Value="1"/>');
    expect(lbrn).toContain('<numPasses Value="8"/>');
    expect((lbrn.match(/<Shape /g) ?? []).length).toBeGreaterThan(3);
    const svg = copperLaserSvg(job);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('width="40mm"');
  });

  test("exports files and a summary from a real fixture board", async () => {
    const out = await mkdtemp(join(tmpdir(), "copper-laser-"));
    const summary = await exportCopperLaserJob({ board: join(import.meta.dir, "../../client-core/src/placement/fixtures/usb-timer.kicad_pcb"), outDir: out });
    expect(summary.counts.pads).toBeGreaterThan(0);
    expect(summary.estimatedSeconds).toBeGreaterThan(0);
    const json = JSON.parse(await readFile(summary.files.json, "utf8"));
    expect(json.settings.ablate.passes).toBeGreaterThan(0);
    expect(await readFile(summary.files.lbrn2, "utf8")).toContain("LightBurnProject");
  });
});

describe("Studio SVG", () => {
  test("only the copper to remove, cropped to its bounds", async () => {
    const { buildCopperLaserJob, copperLaserStudioSvg, ablateBounds } = await import("../src/pcb-laser-copper");
    const pcb = await Bun.file(new URL("../../client-core/src/placement/fixtures/usb-timer.kicad_pcb", import.meta.url)).text();
    const build = buildCopperLaserJob(pcb, {});
    const b = ablateBounds(build)!;
    expect(b.width).toBeGreaterThan(0);
    expect(b.width).toBeLessThanOrEqual(build.board.widthMm + 1);
    const svg = copperLaserStudioSvg(build);
    expect(svg).toContain('id="ABLATE"');
    expect(svg).not.toContain('id="BOARD"');
    expect(svg).not.toContain('id="EDGE"');
    expect(svg).toContain(`width="${+b.width.toFixed(4)}mm"`);
  });
});

describe("geometry engines", () => {
  test("manifold (used for exports) and grid-snapped polygon-clipping give the same job", async () => {
    const { buildCopperLaserJob } = await import("../src/pcb-laser-copper");
    const { solidKernel } = await import("../src/enclosure-solid");
    const kernel = await solidKernel();
    const pcb = await Bun.file(new URL("../../client-core/src/placement/fixtures/usb-timer.kicad_pcb", import.meta.url)).text();
    for (const mode of ["isolation", "full"] as const) {
      const a = buildCopperLaserJob(pcb, { mode });
      const b = buildCopperLaserJob(pcb, { mode }, kernel);
      expect(b.areaMm2.copper).toBeCloseTo(a.areaMm2.copper, 1);
      expect(b.areaMm2.ablate).toBeCloseTo(a.areaMm2.ablate, 1);
    }
    // "full" removes everything that is not copper.
    const full = buildCopperLaserJob(pcb, { mode: "full" }, kernel);
    expect(full.areaMm2.ablate).toBeCloseTo(full.areaMm2.board - full.areaMm2.copper, 0);
  });
});
