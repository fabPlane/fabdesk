import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimatePartHeightMm, extractBoardFeatures } from "../src/board-features";

const fixture = readFileSync(join(import.meta.dir, "fixtures/enclosure/board.kicad_pcb"), "utf8");

describe("extractBoardFeatures", () => {
  test("reads outline, holes, edge connectors and tall parts from a saved board", () => {
    const features = extractBoardFeatures(fixture);
    expect(features.thicknessMm).toBe(1.6);
    expect(features.outline).toMatchObject({ minX: 0, minY: 0, maxX: 50, maxY: 30, widthMm: 50, heightMm: 30 });
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
});

describe("estimatePartHeightMm", () => {
  test("classifies connectors and passives", () => {
    expect(estimatePartHeightMm("Connector_USB:USB_C_Receptacle")).toBe(3.6);
    expect(estimatePartHeightMm("Connector_Audio:Jack")).toBe(12);
    expect(estimatePartHeightMm("Device:R_0402")).toBe(1.2);
    expect(estimatePartHeightMm("Device:C_0805")).toBe(1.2);
  });
});
