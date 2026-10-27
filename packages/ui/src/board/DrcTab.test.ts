import { describe, expect, test } from "bun:test";
import { normalizeReport } from "./DrcTab";

describe("normalizeReport", () => {
  test("displays normalized rule names and retains raw type compatibility", () => {
    const rows = normalizeReport(
      {
        violations: [
          { rule: "silk_edge_clearance", severity: "warning", description: "Silkscreen clipped", items: [] },
          { type: "legacy_type", severity: "error", description: "Legacy report", items: [] },
        ],
        unconnected_items: [{ severity: "error", description: "Open connection", items: [] }],
      },
      "drc",
    );

    expect(rows.map((row) => row.type)).toEqual(["silk_edge_clearance", "legacy_type", "unconnected"]);
  });
});

test("saved normalized reports retain unconnected and schematic-parity findings without duplicating raw aliases", () => {
  const open = { description: "Missing connection", severity: "error", items: [] };
  const parity = { rule: "missing_footprint", description: "Missing footprint", severity: "error", items: [] };
  const rows = normalizeReport({ violations: [{ rule: "clearance", description: "Clearance", severity: "error" }], unconnected: [open], unconnected_items: [open], schematicParity: [parity], schematic_parity: [parity], raw: { violations: [open] } }, "drc");
  expect(rows.map(row => row.type)).toEqual(["clearance", "unconnected", "missing_footprint"]);
});
