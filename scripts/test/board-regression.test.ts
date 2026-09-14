import { describe, expect, test } from "bun:test";
import {
  casesForTier,
  evaluateCase,
  introducedDrcErrors,
  type DrcReport,
  type RegressionManifest,
} from "../lib/board-regression";
import { exists } from "node:fs/promises";
import { resolve } from "node:path";

const report = (rules: string[], unconnected = 0): DrcReport => ({
  violations: rules.map((rule) => ({ rule, severity: "error" })),
  unconnected: Array.from({ length: unconnected }, () => ({
    rule: "unconnected_items",
    severity: "error" as const,
  })),
  schematicParity: [],
  counts: { errors: rules.length, warnings: 0, unconnected },
});

describe("board regression evaluation", () => {
  test("the checked-in manifest names existing fixture and placement files", async () => {
    const directory = resolve(import.meta.dir, "..", "..", "docs", "router-cases");
    const manifest = (await Bun.file(
      resolve(directory, "manifest.json"),
    ).json()) as RegressionManifest;
    for (const testCase of casesForTier(manifest, "nightly")) {
      expect(await exists(resolve(directory, testCase.netlist)), testCase.netlist).toBe(true);
      if (testCase.placement)
        expect(await exists(resolve(directory, testCase.placement)), testCase.placement).toBe(true);
    }
  });

  test("subtracts pre-route placement errors from the post-route DRC", () => {
    expect(
      introducedDrcErrors(
        report(["copper_edge_clearance", "courtyards_overlap"]),
        report(["copper_edge_clearance", "courtyards_overlap", "clearance", "clearance"]),
      ),
    ).toEqual({ clearance: 2 });
  });

  test("unconnected items are tracked by the route result, not misclassified as copper errors", () => {
    expect(introducedDrcErrors(report([], 8), report([], 2))).toEqual({});
  });

  test("gated quality errors and liveness failures fail a case", () => {
    const result = evaluateCase(
      {
        id: "smoke",
        tier: "pr",
        netlist: "smoke.json",
        quality: "gate",
        routeTimeoutMs: 100,
        hardTimeoutMs: 200,
        requireAllRouted: true,
        forbidIntroducedRules: ["clearance"],
      },
      report([]),
      report(["clearance"]),
      { timedOut: false, unrouted: [{}] },
      ["bridge health probe failed"],
    );
    expect(result.failures).toEqual([
      "bridge health probe failed",
      "1 connection(s) remained open",
      "routing introduced 1 clearance error(s)",
    ]);
  });

  test("known quality failures and cooperative timeouts observe, but liveness still gates", () => {
    const result = evaluateCase(
      {
        id: "known-bad",
        tier: "nightly",
        netlist: "bad.json",
        quality: "observe",
        routeTimeoutMs: 100,
        hardTimeoutMs: 200,
        forbidIntroducedRules: ["shorting_items"],
      },
      report([]),
      report(["shorting_items"]),
      { timedOut: true, unrouted: [{}, {}] },
    );
    expect(result.failures).toEqual([]);
    expect(result.observations).toEqual([
      "router reported a timeout",
      "routing introduced 1 shorting_items error(s)",
      "2 connection(s) remained open",
    ]);
  });

  test("the PR tier is a subset and manifest mistakes fail early", () => {
    const manifest: RegressionManifest = {
      schema: 1,
      cases: [
        { id: "a", tier: "pr", netlist: "a", quality: "gate", routeTimeoutMs: 1, hardTimeoutMs: 2 },
        {
          id: "b",
          tier: "nightly",
          netlist: "b",
          quality: "observe",
          routeTimeoutMs: 1,
          hardTimeoutMs: 2,
        },
      ],
    };
    expect(casesForTier(manifest, "pr").map((c) => c.id)).toEqual(["a"]);
    expect(casesForTier(manifest, "nightly").map((c) => c.id)).toEqual(["a", "b"]);
    manifest.cases[1]!.id = "a";
    expect(() => casesForTier(manifest, "nightly")).toThrow("duplicate regression case id a");
  });
});
