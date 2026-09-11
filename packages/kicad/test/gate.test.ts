import { describe, expect, test } from "bun:test";
import { countCopperLayers, gate, parseDrcJson, parseErcJson, type DrcReport, type ErcReport } from "../src/index";

const v = (rule: string, severity: "error" | "warning" | "exclusion", item = "Footprint R1") => ({
  type: rule,
  severity,
  description: `${rule} description`,
  items: [{ description: item, uuid: "u", pos: { x: 1, y: 2 } }],
});

const drc = (over: Partial<{ violations: unknown[]; unconnected_items: unknown[]; schematic_parity: unknown[] }> = {}): DrcReport =>
  parseDrcJson({ violations: [], unconnected_items: [], schematic_parity: [], ...over } as never);
const erc = (violations: unknown[] = []): ErcReport => parseErcJson({ sheets: [{ path: "/", violations }] } as never);

describe("parseDrcJson", () => {
  test("normalises violations and builds signatures", () => {
    const report = drc({ violations: [v("text_height", "warning"), v("clearance", "error", "Track on F.Cu")], unconnected_items: [v("unconnected_items", "error")] });
    expect(report.counts).toEqual({ errors: 1, warnings: 1, unconnected: 1 });
    expect(report.violations[0]?.signature).toBe("text_height:Footprint R1");
    expect(report.violations[0]?.items[0]?.pos).toEqual({ x: 1, y: 2 });
    expect(parseDrcJson({ violations: [{ type: "x" }] } as never).violations[0]?.signature).toBe("x:NO_REFERENCE");
  });

  test("retains agent-facing item geometry metadata", () => {
    const report = parseDrcJson({
      violations: [{
        type: "clearance",
        severity: "error",
        description: "clearance violation",
        items: [{
          description: "Track GND",
          uuid: "track-1",
          pos: { x: 4.5, y: 6.25 },
          net: "GND",
          layer: "F.Cu",
          layers: ["F.Cu", "B.Cu"],
        }],
      }],
    } as never);
    expect(report.violations[0]).toMatchObject({
      rule: "clearance",
      severity: "error",
      coordinates: [{ x: 4.5, y: 6.25 }],
      layers: ["F.Cu", "B.Cu"],
      nets: ["GND"],
      objectIds: ["track-1"],
      affectedGeometry: [],
    });
  });
});

describe("gate", () => {
  test("passes a clean board", () => {
    expect(gate(drc(), erc(), [])).toEqual({ pass: true, reasons: [], newWarningSignatures: [] });
    expect(gate(drc(), undefined, []).pass).toBe(true);
  });
  test("fails on DRC errors, unconnected items and ERC errors", () => {
    expect(gate(drc({ violations: [v("clearance", "error")] }), undefined, []).reasons).toEqual(["1 DRC error(s)"]);
    expect(gate(drc({ unconnected_items: [v("unconnected_items", "error")] }), undefined, []).reasons).toEqual(["1 unconnected item(s)"]);
    expect(gate(drc({ schematic_parity: [v("footprint_symbol_mismatch", "error")] }), undefined, []).pass).toBe(false);
    const r = gate(drc(), erc([v("pin_not_connected", "error", "Symbol U1")]), []);
    expect(r.reasons).toEqual(["1 ERC error(s)"]);
  });
  test("warnings must be in the allowed baseline; ERC warnings and exclusions are ignored", () => {
    const report = drc({ violations: [v("text_height", "warning"), v("text_height", "warning", "Footprint R2"), v("silk_overlap", "exclusion")] });
    const failing = gate(report, erc([v("endpoint_off_grid", "warning")]), ["text_height:Footprint R1"]);
    expect(failing.pass).toBe(false);
    expect(failing.newWarningSignatures).toEqual(["text_height:Footprint R2"]);
    const passing = gate(report, erc([v("endpoint_off_grid", "warning")]), ["text_height:Footprint R1", "text_height:Footprint R2"]);
    expect(passing.pass).toBe(true);
  });
});

describe("countCopperLayers", () => {
  test("counts F/B/In layers in the header", () => {
    const text = `(kicad_pcb (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal) (32 "B.Adhes" user)))`;
    expect(countCopperLayers(text)).toBe(4);
    expect(countCopperLayers("(kicad_pcb)")).toBe(0);
  });
});
