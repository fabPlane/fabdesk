import { expect, test } from "bun:test";
import type { MechanicalFitReport } from "@fabdesk/protocol";
import { enclosureReadiness, fitIssueBoardPath } from "./enclosure-readiness";

test("fit actions select an affected board for boundary and two-board collisions", () => {
  const paths = ["board.kicad_pcb", "hardware/board.kicad_pcb"];
  expect(fitIssueBoardPath("hardware/board.kicad_pcb: outside", paths)).toBe(paths[1]!);
  expect(
    fitIssueBoardPath(
      "board.kicad_pcb and hardware/board.kicad_pcb have overlapping clearance envelopes.",
      paths,
    ),
  ).toBe(paths[0]!);
  expect(fitIssueBoardPath("Missing geometry", paths)).toBeNull();
});

const report: MechanicalFitReport = {
  status: "review",
  checkedBoards: 1,
  boardRevisions: {},
  coverage: "bounds",
  issues: [],
};
test("export readiness cannot pass stale, absent, loading or blocking checks", () => {
  expect(enclosureReadiness(false, report, false).canExport).toBe(false);
  expect(enclosureReadiness(true, null, false).canExport).toBe(false);
  expect(enclosureReadiness(true, report, true).canExport).toBe(false);
  expect(
    enclosureReadiness(
      true,
      { ...report, issues: [{ code: "collision", severity: "error", message: "overlap" }] },
      false,
    ).kind,
  ).toBe("blocked");
  expect(enclosureReadiness(true, { ...report, status: "blocked" }, false).canExport).toBe(false);
});
test("review items allow explicitly qualified prototype export", () => {
  const review = enclosureReadiness(
    true,
    {
      ...report,
      issues: [{ code: "detailed-missing", severity: "review", message: "Missing capacitor" }],
    },
    false,
  );
  expect(review.kind).toBe("review");
  expect(review.canExport).toBe(true);
  expect(review.detail).toContain("physical fit is unverified");
  expect(enclosureReadiness(true, report, false).title).toBe("Ready for prototype export");
});
