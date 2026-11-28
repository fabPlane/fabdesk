import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { chatSummary, isFabCheckReport, markerPercent, verdictTone, type FabCheckReport } from "./fab-check";
import { FabCheckSummaryCard } from "./FabCheckTab";

const report: FabCheckReport = {
  version: 1,
  createdAt: "2026-11-02T00:00:00.000Z",
  overall: "fail",
  fab: "generic",
  rules: { label: "Generic (0.15 mm)", minSpacingMm: 0.15, minTraceMm: 0.15 },
  packageHash: "abc",
  source: "exports/gerbers",
  layerCount: 2,
  files: ["gerbers/board-F_Cu.gbr"],
  checks: [
    { id: "completeness", title: "Package completeness", verdict: "fail", summary: "Drill missing", findings: [] },
    { id: "clearance", title: "Copper clearance", verdict: "pass", summary: "ok", findings: [] },
  ],
  findings: [
    { id: "missing-drill", check: "completeness", severity: "fail", message: "No Excellon drill file was found." },
  ],
  renders: [{ layer: "top-composite", kind: "other", side: "top", pngPath: "reports/fab-check/layers/top-composite.png", svgPath: "reports/fab-check/layers/top-composite.svg" }],
};

describe("fab check report panel", () => {
  test("accepts a stored report and builds a chat summary", () => {
    expect(isFabCheckReport(report)).toBe(true);
    expect(isFabCheckReport({ version: 2 })).toBe(false);
    expect(verdictTone("fail")).toBe("danger");
    expect(chatSummary(report)).toEqual({
      title: "Fab package fail",
      lines: ["Package completeness: fail", "Copper clearance: pass"],
    });
    const html = renderToStaticMarkup(<FabCheckSummaryCard report={report} />);
    expect(html).toContain("Fab package fail");
    expect(html).toContain("Package completeness");
    expect(html).toContain('data-testid="fab-check-chat-card"');
  });

  test("maps finding coordinates onto the layer render", () => {
    expect(markerPercent({ minX: 0, minY: 0, maxX: 10, maxY: 20 }, 5, 10)).toEqual({
      left: "50%",
      top: "50%",
    });
    expect(markerPercent(undefined, 1, 1)).toEqual({ left: "50%", top: "50%" });
  });
});
