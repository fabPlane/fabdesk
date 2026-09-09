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
