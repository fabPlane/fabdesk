import { expect, test } from "bun:test";
import type { MechanicalFitIssue } from "@fabdesk/protocol";
import { enclosureReviewGroups } from "./enclosure-review";

test("repeated findings become tasks without losing board-specific findings", () => {
  const issues: MechanicalFitIssue[] = [
    { code: "mount-none", severity: "review", message: "a.kicad_pcb: no posts" },
    { code: "mount-none", severity: "review", message: "b.kicad_pcb: no posts" },
    { code: "port-measurements", severity: "review", message: "b.kicad_pcb: J1 unknown" },
    { code: "new-check-code", severity: "review", message: "New unknown finding" },
  ];
  const groups = enclosureReviewGroups(issues);
  expect(groups.map((g) => g.id)).toEqual(["secure", "plugs", "other"]);
  expect(groups[0]!.issues).toEqual(issues.slice(0, 2));
  expect(groups.flatMap((g) => g.issues)).toEqual(issues);
  expect(groups[0]!.issues[0]).toBe(issues[0]!); // Preserve selection/highlight identity.
});

test("errors never become optional tasks, even with an informational code", () => {
  expect(
    enclosureReviewGroups([
      { code: "coverage", severity: "error", message: "Blocking finding" },
      { code: "mount-none", severity: "error", message: "Blocking support" },
    ]),
  ).toEqual([]);
});

test("check limitations stay in the report without inflating action counts", () => {
  const codes = [
    "coverage",
    "import-coverage",
    "shell-coverage",
    "detailed-coverage",
    "detailed-layers",
    "assembly-sampled",
  ];
  const groups = enclosureReviewGroups(
    codes.map((code) => ({ code, severity: "review", message: code })),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]!.id).toBe("method");
  expect(groups[0]!.issues).toHaveLength(codes.length);
  expect(
    enclosureReviewGroups([
      { code: "detailed-missing", severity: "review", message: "Missing parts" },
    ])[0]!.id,
  ).toBe("models");
});
