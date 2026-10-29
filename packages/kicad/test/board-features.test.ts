import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimatePartHeightMm, extractBoardFeatures } from "../src/board-features";

const fixture = readFileSync(join(import.meta.dir, "fixtures/enclosure/board.kicad_pcb"), "utf8");

describe("extractBoardFeatures", () => {
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
    ]);
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
