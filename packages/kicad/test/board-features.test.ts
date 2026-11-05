import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimatePartHeightMm, extractBoardFeatures } from "../src/board-features";

const fixture = readFileSync(join(import.meta.dir, "fixtures/enclosure/board.kicad_pcb"), "utf8");

describe("extractBoardFeatures", () => {
  test("pad fallback agrees with native KiCad copper export, including offsets and rounded ends", () => {
    // pad-bounds.native.svg was exported by KiCad 10.99.0. Its first two polygons
    // are the rectangle bounds below; the oval is a 2 mm round-capped line.
    const board = readFileSync(
      join(import.meta.dir, "fixtures/enclosure/pad-bounds.kicad_pcb"),
      "utf8",
    );
    const parts = extractBoardFeatures(board).components!;
    expect(parts.find((p) => p.ref === "U1")!.bounds).toEqual({
      minX: 11,
      minY: 6,
      maxX: 13,
      maxY: 14,
    });
    expect(parts.find((p) => p.ref === "U2")!.bounds).toEqual({
      minX: 31,
      minY: 4,
      maxX: 33,
      maxY: 12,
    });
    const oval = parts.find((p) => p.ref === "U3")!.bounds;
    expect(oval.minX).toBeCloseTo(41.8787, 4);
    expect(oval.maxX).toBeCloseTo(48.1213, 4);
    expect(oval.minY).toBeCloseTo(6.8787, 4);
    expect(oval.maxY).toBeCloseTo(13.1213, 4);
    // Copper offset must not move the actual manufactured hole.
    expect(extractBoardFeatures(board).holes[0]).toMatchObject({ x: 32, y: 10, diameterMm: 0.8 });
  });
  test("rounded rectangular pads retain their rounded envelope when turned diagonally", () => {
    const f = extractBoardFeatures(`(kicad_pcb
      (gr_rect(start 0 0)(end 40 30)(layer "Edge.Cuts"))
      (footprint "Device:Test"(layer "B.Cu")(at 20 15 90)(property "Reference" "U1")
        (pad "1" smd roundrect(at 0 0 45)(size 8 4)(roundrect_rratio 0.25)(layers "B.Cu"))))`);
    const part = f.components![0]!;
    const halfExtent = 4 / Math.sqrt(2) + 1;
    expect(part.bottom).toBe(true);
    expect(part.bounds.minX).toBeCloseTo(20 - halfExtent, 6);
    expect(part.bounds.maxY).toBeCloseTo(15 + halfExtent, 6);
  });
  test("pad-only bounds use board-frame pad rotation independently of footprint rotation", () => {
    for (const angle of [0, 90, 135, 270]) {
      const features = extractBoardFeatures(`(kicad_pcb
        (gr_rect(start 0 0)(end 40 30)(layer "Edge.Cuts"))
        (footprint "Device:Test"(layer "F.Cu")(at 10 10 90)(property "Reference" "U1")
          (pad "1" smd rect(at 0 2 ${angle})(size 8 2)(layers "F.Cu"))))`);
      const r = features.components![0]!.bounds;
      const a = (angle * Math.PI) / 180;
      const halfX = 4 * Math.abs(Math.cos(a)) + Math.abs(Math.sin(a));
      const halfY = 4 * Math.abs(Math.sin(a)) + Math.abs(Math.cos(a));
      expect(r.minX).toBeCloseTo(12 - halfX, 6);
      expect(r.maxX).toBeCloseTo(12 + halfX, 6);
      expect(r.minY).toBeCloseTo(10 - halfY, 6);
      expect(r.maxY).toBeCloseTo(10 + halfY, 6);
    }
  });
  test("curved footprint outlines include arc extrema and transform into board coordinates", () => {
    const features = extractBoardFeatures(`(kicad_pcb
      (gr_rect(start 0 0)(end 40 30)(layer "Edge.Cuts"))
      (footprint "Connector_Audio:Test"(layer "F.Cu")(at 0 10 90)(property "Reference" "J1")
        (fp_line(start -4 0)(end 4 0)(layer "F.CrtYd"))
        (fp_arc(start 4 0)(mid 0 4)(end -4 0)(layer "F.CrtYd"))
        (fp_line(start -3 0)(end 3 0)(layer "F.Fab"))
        (fp_arc(start 3 0)(mid 0 3)(end -3 0)(layer "F.Fab"))
        (pad "1" smd rect(at 0 0)(size 1 1)(layers "F.Cu"))))`);
    const body = features.components![0]!.bounds;
    const face = features.connectors[0]!.face!.bounds;
    for (const [key, value] of Object.entries({ minX: 0, minY: 6, maxX: 4, maxY: 14 }))
      expect(body[key as keyof typeof body]).toBeCloseTo(value, 6);
    for (const [key, value] of Object.entries({ minX: 0, minY: 7, maxX: 3, maxY: 13 }))
      expect(face[key as keyof typeof face]).toBeCloseTo(value, 6);
  });
  test("a missing courtyard falls back to the body outline as well as pads", () => {
    const features = extractBoardFeatures(`(kicad_pcb
      (gr_rect(start 0 0)(end 40 30)(layer "Edge.Cuts"))
      (footprint "Device:Test"(layer "F.Cu")(at 20 15)(property "Reference" "U1")
        (fp_rect(start -6 -4)(end 6 4)(layer "F.Fab"))
        (pad "1" smd rect(at 7 0)(size 2 2)(layers "F.Cu"))))`);
    expect(features.components![0]!.bounds).toEqual({ minX: 14, minY: 11, maxX: 28, maxY: 19 });
  });
  test("connected rectangular segments are closed regardless of order or direction", () => {
    const edges = [
      [100, 74, 100, 50],
      [152, 74, 100, 74],
      [100, 50, 152, 50],
      [152, 50, 152, 74],
    ];
    const lines = edges.map(
      ([x, y, x1, y1]) => `(gr_line (start ${x} ${y})(end ${x1} ${y1})(layer "Edge.Cuts"))`,
    );
    const parsed = (parts: string[]) =>
      extractBoardFeatures(`(kicad_pcb (general (thickness 1.6)) ${parts.join(" ")})`);
    const complete = parsed(lines);
    expect(complete.outline.closed).toBe(true);
    expect(complete.warnings).not.toContain(
      "Edge.Cuts segments may not form a closed contour; the enclosure uses the bounding box",
    );
    expect(parsed(lines.slice(1)).outline.closed).toBe(false);
    expect(parsed([...lines, lines[0]!]).outline.closed).toBe(false);
    // A closed primitive elsewhere does not make an unrelated open chain closed.
    expect(
      parsed([...lines.slice(1), '(gr_rect (start 1 1)(end 2 2)(layer "Edge.Cuts"))']).outline
        .closed,
    ).toBe(false);
  });
  test("open arcs remain open and exact extrema bound unsampled angles", () => {
    const p = (a: number) =>
      `${20 * Math.cos((a * Math.PI) / 180)} ${20 * Math.sin((a * Math.PI) / 180)}`;
    const arc = `(gr_arc (start ${p(11)})(mid ${p(97)})(end ${p(203)})(layer "Edge.Cuts"))`;
    const f = extractBoardFeatures(`(kicad_pcb (general (thickness 1.6))${arc})`);
    expect(f.outline.closed).toBe(false);
    expect(f.outline.minX).toBe(-20);
    expect(f.outline.maxY).toBe(20);
    expect(f.outline.minY).toBeCloseTo(20 * Math.sin((203 * Math.PI) / 180), 3);
    const legacy = extractBoardFeatures(
      `(kicad_pcb (general (thickness 1.6))(gr_arc (start 0 0)(end ${p(11)})(angle -192)(layer "Edge.Cuts")))`,
    );
    expect(legacy.outline.minX).toBe(-20);
    expect(legacy.outline.maxY).toBe(20);
    expect(legacy.outline.closed).toBe(false);
  });
  test("closed irregular contours disclose rectangular estimates", () => {
    const f = extractBoardFeatures(
      '(kicad_pcb (general (thickness 1.6))(gr_poly (pts (xy 0 0)(xy 10 0)(xy 5 8))(layer "Edge.Cuts")))',
    );
    expect(f.outline.closed).toBe(true);
    expect(f.warnings.some((w) => w.includes("Non-rectangular"))).toBe(true);
  });
  test("reads outline, holes, edge connectors and tall parts from a saved board", () => {
    const features = extractBoardFeatures(fixture);
    expect(features.thicknessMm).toBe(1.6);
    expect(features.components?.some((p) => /MountingHole/.test(p.footprint))).toBe(false);
    expect(features.outline).toMatchObject({
      minX: 0,
      minY: 0,
      maxX: 50,
      maxY: 30,
      widthMm: 50,
      heightMm: 30,
    });
    expect(features.holes.map((h) => [h.x, h.y, h.diameterMm])).toEqual([
      [4, 4, 2.2],
      [46, 26, 2.2],
      [50, 15, 0.8],
    ]);
    expect(features.holes.map((h) => h.purpose)).toEqual(["unclassified", "mounting", "component"]);
    expect(features.connectors.map((c) => c.ref).sort()).toEqual(["J1", "J2"]);
    const usb = features.connectors.find((c) => c.ref === "J1")!;
    expect(usb.edge).toBe("minY");
    expect(usb.heightMm).toBe(3.6);
    const jack = features.connectors.find((c) => c.ref === "J2")!;
    expect(jack.edge).toBe("maxX");
    expect(features.tallParts.map((p) => p.ref)).toEqual(["C1"]);
    expect(features.pcbRevision).toHaveLength(64);
  });

  test("rejects a file that is not a board or has no Edge.Cuts", () => {
    expect(() => extractBoardFeatures("(kicad_sch)")).toThrow(/kicad_pcb/);
    expect(() => extractBoardFeatures("(kicad_pcb (version 20260831))")).toThrow(/Edge\.Cuts/);
  });

  test("rotates footprint pads clockwise like KiCad RotatePoint", () => {
    const board = `(kicad_pcb (version 20260831) (general (thickness 1.6))
      (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts"))
      (footprint "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"
        (layer "F.Cu") (at 10 0 90)
        (property "Reference" "J3")
        (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1))
        (pad "2" thru_hole circle (at 0 2.54) (size 1.7 1.7) (drill 1))
        (pad "3" thru_hole circle (at 0 5.08) (size 1.7 1.7) (drill 1))
        (pad "4" thru_hole circle (at 0 7.62) (size 1.7 1.7) (drill 1))))`;
    const features = extractBoardFeatures(board);
    const header = features.connectors.find((c) => c.ref === "J3");
    expect(header).toBeDefined();
    // CW 90° maps local +Y onto +X, so the 1x04 body sits to the +X side of pin 1.
    expect(header!.bounds.minX).toBeGreaterThan(10 - 1);
    expect(header!.bounds.maxX).toBeGreaterThan(10 + 6);
    expect((header!.bounds.minX + header!.bounds.maxX) / 2).toBeCloseTo(10 + 3.81, 1);
  });

  test("does not invent a standoff under a fiducial copper pad", () => {
    const board = `(kicad_pcb (version 20260831) (general (thickness 1.6))
      (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts"))
      (footprint "Fiducial:Fiducial_0.5mm_Mask1mm"
        (layer "F.Cu") (at 10 10)
        (property "Reference" "FID1")
        (pad "1" smd circle (at 0 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask"))))`;
    const features = extractBoardFeatures(board);
    expect(features.holes).toEqual([]);
    expect(features.components).toEqual([]);
  });

  test("reads a round board whose Edge.Cuts are only gr_arc", () => {
    const board = `(kicad_pcb (version 20260831) (general (thickness 1.6))
      (gr_arc (start 20 0) (mid 0 20) (end -20 0) (layer "Edge.Cuts"))
      (gr_arc (start -20 0) (mid 0 -20) (end 20 0) (layer "Edge.Cuts")))`;
    const features = extractBoardFeatures(board);
    expect(features.outline.source).toBe("gr_arc");
    expect(features.outline.closed).toBe(true);
    expect(features.outline.minX).toBeCloseTo(-20, 1);
    expect(features.outline.maxX).toBeCloseTo(20, 1);
    expect(features.outline.minY).toBeCloseTo(-20, 1);
    expect(features.outline.maxY).toBeCloseTo(20, 1);
  });
});

describe("estimatePartHeightMm", () => {
  test("classifies connectors and passives", () => {
    expect(estimatePartHeightMm("Connector_USB:USB_C_Receptacle")).toBe(3.6);
    expect(estimatePartHeightMm("Connector_Audio:Jack")).toBe(12);
    expect(estimatePartHeightMm("Device:R_0402")).toBe(1.2);
    expect(estimatePartHeightMm("Device:C_0805")).toBe(1.2);
  });
});
