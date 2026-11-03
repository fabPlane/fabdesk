import { expect, test } from "bun:test";
import { enclosureIssueRoute } from "./enclosure-issue-navigation";

test("hardware warnings return to their settings instead of opening case dimensions", () => {
  for (const [code, target] of [
    ["closure-length", "lid-screws"],
    ["closure-size", "lid-screws"],
    ["holder-closure", "lid"],
    ["holder-tolerance", "holders"],
    ["holder-space", "holders"],
    ["holder-collision", "holders"],
    ["fit-allowance", "allowance"],
    ["hardware-access", "hardware"],
    ["assembly-unavailable", "model-checks"],
    ["assembly-sampled", "assembly-checks"],
  ] as const) {
    expect(enclosureIssueRoute(code)).toEqual({ target, step: "Start", disclosure: null });
  }
});

test("cable and mounting recovery opens its own disclosure, never unrelated ports", () => {
  for (const code of ["cable-route-blocked", "cable-endpoint", "cable-length", "cable-routing"])
    expect(enclosureIssueRoute(code)).toEqual({
      target: "cables",
      step: "Start",
      disclosure: "layout",
    });
  for (const code of [
    "mount-hole",
    "mount-none",
    "mount-bounds",
    "screw-length",
    "screw-engagement",
    "screw-head-unknown",
  ])
    expect(enclosureIssueRoute(code)).toEqual({
      target: "mounts",
      step: "Start",
      disclosure: "case",
    });
  expect(enclosureIssueRoute("case-size-limit")).toEqual({
    target: "print-area",
    step: "Start",
    disclosure: "layout",
  });
  expect(enclosureIssueRoute("opening-web")).toEqual({
    target: "openings",
    step: "Start",
    disclosure: "case",
  });
});

test("model findings and board selection stay on Boards; collision recovery preserves placement", () => {
  for (const code of [
    "detailed-layers",
    "detailed-missing",
    "detailed-open",
    "detailed-unavailable",
  ])
    expect(enclosureIssueRoute(code)).toEqual({ target: "models", step: "PCB", disclosure: null });
  expect(enclosureIssueRoute("no-board")?.step).toBe("PCB");
  expect(enclosureIssueRoute("board-geometry")?.step).toBe("PCB");
  for (const code of [
    "outside-space",
    "native-clearance",
    "board-collision",
    "detailed-collision",
    "detailed-clearance",
    "shell-surface",
    "shell-clearance",
    "assembly-obstruction",
    "screw-tool-access",
  ])
    expect(enclosureIssueRoute(code)).toEqual({
      target: "placement",
      step: "Start",
      disclosure: null,
    });
});

test("only dimension findings lead to dimensions; unknown future checks do not guess", () => {
  expect(enclosureIssueRoute("dimensions")).toEqual({
    target: "dimensions",
    step: "Start",
    disclosure: "size",
  });
  expect(enclosureIssueRoute("future-check")).toBeNull();
});
