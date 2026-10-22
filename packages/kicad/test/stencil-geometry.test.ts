import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildSolderStencil,
  checkMesh,
  pointInRing,
  stencilPreviewSvg,
  type Ring,
} from "../src/stencil";

const fixture = await Bun.file(
  join(import.meta.dir, "fixtures/stencil-geometry-regressions.kicad_pcb"),
).text();
const nightly = await Bun.file(
  join(import.meta.dir, "fixtures/stencil-nightly-metadata.kicad_pcb"),
).text();
const area = (ring: Ring) =>
  Math.abs(
    ring.reduce((sum, [x, y], i) => {
      const next = ring[(i + 1) % ring.length]!;
      return sum + x * next[1] - next[0] * y;
    }, 0) / 2,
  );
const bounds = (ring: Ring) => [
  Math.min(...ring.map((p) => p[0])),
  Math.min(...ring.map((p) => p[1])),
  Math.max(...ring.map((p) => p[0])),
  Math.max(...ring.map((p) => p[1])),
];

// Expected positions/dimensions were independently checked against KiCad
// 10.99.0-5073's F.Paste/B.Paste Gerber exports, not another app transform.
describe("native paste geometry regressions", () => {
  const front = buildSolderStencil(fixture);

  test("rotates local positions in KiCad's Y-down coordinates, using absolute pad angles", () => {
    const r90 = front.apertures.find((p) => p.ref === "R90")!;
    expect([r90.x, r90.y]).toEqual([10, 8]);
    expect(bounds(r90.polygon)).toEqual([9.53, 7.04, 10.47, 8.96]);
    const r45 = front.pads.find((p) => p.ref === "R45")!;
    expect(r45.x).toBeCloseTo(22.12132, 5);
    expect(r45.y).toBeCloseTo(9.292893, 5);
    expect(r45.angle).toBe(30); // Not 45 + 30.
    const a = front.apertures.find((p) => p.ref === "R45")!;
    expect(pointInRing(22.8, 8.8, a.polygon)).toBe(true);
    expect(pointInRing(22.8, 9.8, a.polygon)).toBe(false);
  });

  test("does not mirror bottom pads a second time; tooling holes use the same transform", () => {
    const bottom = buildSolderStencil(fixture, { side: "B", alignment: "holes" });
    expect(bottom.pads).toHaveLength(1);
    expect([bottom.pads[0]!.x, bottom.pads[0]!.y, bottom.pads[0]!.angle]).toEqual([31, 8, 90]);
    expect(bottom.alignmentHoles).toEqual([
      { x: 51, y: 8, diameterMm: 3.2 },
      { x: 51, y: 12, diameterMm: 3.2 },
    ]);
    expect(checkMesh(bottom.plateMesh).watertight).toBe(true);
  });

  test("stacked USB records do not become zero pitch, even with fine-pitch filtering enabled", () => {
    const filtered = buildSolderStencil(fixture, { skipFinePitch: true, finePitchMm: 0.5 });
    expect(filtered.pads.filter((p) => p.ref === "USB")).toHaveLength(4);
    expect(filtered.apertures.filter((p) => p.ref === "USB")).toHaveLength(4);
    expect(filtered.skipped.filter((p) => p.ref === "USB")).toHaveLength(0);
    expect(filtered.warnings.filter((w) => w.ref === "USB")).toHaveLength(0);
    // Four records make three physical holes; count the union in the preview.
    expect(stencilPreviewSvg(front)).toContain("9 apertures");
    expect(checkMesh(front.plateMesh).watertight).toBe(true);
    const strict = buildSolderStencil(fixture, { skipFinePitch: true, finePitchMm: 0.6 });
    expect(strict.skipped.filter((p) => p.ref === "USB")).toHaveLength(4);
  });

  test("preserves small apertures by default and adds no invented alignment holes", () => {
    expect(front.skipped).toHaveLength(0);
    expect(front.alignmentHoles).toHaveLength(0);
    expect(front.apertures.find((p) => p.ref === "USB")!.width).toBeCloseTo(0.254, 6);
    const filtered = buildSolderStencil(fixture, { minApertureMm: 0.35 });
    expect(filtered.skipped.filter((p) => p.ref === "USB")).toHaveLength(4);
  });

  test("resolves board/pad paste margin and ratio, respecting explicit zero overrides", () => {
    const inherited = front.apertures.find((p) => p.ref === "R90")!;
    expect([inherited.width, inherited.height]).toEqual([1.92, 0.94]);
    const local = front.apertures.find((p) => p.ref === "MARGIN" && p.number === "1")!;
    expect(local.width).toBeCloseTo(1.4, 6);
    expect(local.height).toBeCloseTo(0.6, 6);
    const zero = front.apertures.find((p) => p.ref === "MARGIN" && p.number === "2")!;
    expect([zero.width, zero.height]).toEqual([2, 1]);
    const inheritedFootprint = buildSolderStencil(
      fixture.replace("(solder_paste_margin 0)(solder_paste_margin_ratio 0)", ""),
    );
    const p = inheritedFootprint.apertures.find((p) => p.ref === "MARGIN" && p.number === "2")!;
    expect(p.width).toBeCloseTo(1.78, 6);
    expect(p.height).toBeCloseTo(0.84, 6);
  });

  test("roundrect corners are rounded and ovals are capsules, not rectangles or ellipses", () => {
    const r = front.apertures.find((p) => p.ref === "ROUND")!;
    const radius = 0.235;
    expect(area(r.polygon)).toBeCloseTo(1.92 * 0.94 - (4 - Math.PI) * radius ** 2, 2);
    expect(pointInRing(30.95, 20.46, r.polygon)).toBe(false);
    const o = front.apertures.find((p) => p.ref === "OVAL")!;
    expect(area(o.polygon)).toBeCloseTo((2.9 - 0.94) * 0.94 + Math.PI * (0.94 / 2) ** 2, 1);
    expect(area(o.polygon)).toBeGreaterThan((Math.PI * 2.9 * 0.94) / 4 + 0.3);
  });

  test("reads the real nightly transform format and ignores only custom-property metadata", () => {
    const result = buildSolderStencil(nightly);
    expect(result.pads[0]).toMatchObject({ ref: "U6", x: 10, y: 8, angle: 90 });
    expect(result.apertures[0]!.width).toBe(0.67);
    expect(checkMesh(result.plateMesh).watertight).toBe(true);
    const unsupported = nightly.replace("(scale 1 1)", "(scale 2 1)");
    expect(() => buildSolderStencil(unsupported)).toThrow(/scaled footprint/);
    expect(() =>
      buildSolderStencil(nightly.replace("custom_property", "unknown_geometry")),
    ).toThrow();
  });

  test("identical reference labels in different footprints are not one pitch group", () => {
    const extra = `(footprint "Test:R" (layer "F.Cu") (at 10.1 20)
      (property "Reference" "USB")
      (pad "1" smd rect (at 0 0)(size .3 .8)(layers "F.Paste")))`;
    const b = buildSolderStencil(fixture.slice(0, fixture.lastIndexOf(")")) + extra + ")", {
      skipFinePitch: true,
    });
    expect(b.skipped).toHaveLength(0);
  });

  test("unsupported paste artwork or pad shapes fail instead of silently omitting/changing holes", () => {
    const graphic =
      '(gr_rect (start 2 2)(end 3 3)(stroke (width .1)(type default))(fill none)(layer "F.Paste"))';
    expect(() =>
      buildSolderStencil(fixture.slice(0, fixture.lastIndexOf(")")) + graphic + ")"),
    ).toThrow(/Unsupported F.Paste gr_rect/);
    expect(() => buildSolderStencil(fixture.replace("smd rect", "smd custom"))).toThrow(
      /Unsupported paste pad/,
    );
    expect(() =>
      buildSolderStencil(fixture.replace('(layer "F.SilkS")', '(layer "F.Paste")')),
    ).toThrow(/Unsupported F.Paste property/);
  });

  test("includes separate paste rectangles without inheriting copper-pad paste margins", () => {
    const graphic =
      '(gr_rect (start 2 2)(end 3 3)(stroke (width 0)(type default))(fill solid)(layer "F.Paste"))';
    const b = buildSolderStencil(fixture.slice(0, fixture.lastIndexOf(")")) + graphic + ")");
    const p = b.apertures.find((p) => p.ref === "board")!;
    expect(bounds(p.polygon)).toEqual([2, 2, 3, 3]);
    const copper = `(footprint "Test:Copper" (layer "F.Cu") (at 5 5 90)
      (pad "1" smd custom (at 0 0)(size 1 1)(layers "F.Cu")
        (primitives (gr_rect (start 0 0)(end 1 1)(width 0)(fill yes))))
      (fp_rect (start 2 0)(end 3 1)(stroke (width 0)(type default))(fill yes)(layer "F.Paste")))`;
    const c = buildSolderStencil(fixture.slice(0, fixture.lastIndexOf(")")) + copper + ")");
    expect(bounds(c.apertures.at(-1)!.polygon)).toEqual([5, 2, 6, 3]);
  });

  test("collinear rounded openings do not emit degenerate cap triangles", () => {
    const pcb = `(kicad_pcb (version 20241229) (generator "test")
      (layers (0 "F.Cu" signal)(35 "F.Paste" user)(44 "Edge.Cuts" user))
      (gr_rect (start 0 -7.35)(end 48.2 40)(layer "Edge.Cuts")(stroke (width .05)(type default))(fill none))
      (footprint "Test:R" (layer "F.Cu")(at 32.8 .1 180)(property "Reference" "R27")
      (pad "1" smd roundrect (at -.51 0 180)(size .54 .64)(layers "F.Paste")(roundrect_rratio .25))
      (pad "2" smd roundrect (at .51 0 180)(size .54 .64)(layers "F.Paste")(roundrect_rratio .25))))`;
    const mesh = buildSolderStencil(pcb, { frameMm: 10, thicknessMm: 0.2 }).plateMesh;
    expect(checkMesh(mesh).watertight).toBe(true);
    for (let i = 0; i < mesh.positions.length; i += 9) {
      const p = mesh.positions;
      const u = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
      const v = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
      expect(
        Math.hypot(
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        ),
      ).toBeGreaterThan(0);
    }
  });

  test("rejects non-finite dimensions before attempting polygon or mesh work", () => {
    expect(() => buildSolderStencil(fixture, { thicknessMm: Infinity })).toThrow(/finite/);
    expect(() => buildSolderStencil(fixture, { apertureOffsetMm: NaN })).toThrow(/finite/);
    expect(() => buildSolderStencil(fixture, { minApertureMm: -1 })).toThrow(/minAperture/);
  });
});
