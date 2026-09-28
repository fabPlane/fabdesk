import { describe, expect, test } from "bun:test";
import type { RouteRunSummary } from "@fabdesk/client-core";
import { describeRun, runDuration, runTitle, sortRuns } from "./route-runs";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function run(patch: Partial<RouteRunSummary>): RouteRunSummary {
  return {
    id: "r1",
    projectId: "p1",
    router: "capacity",
    status: "completed",
    framesPath: "/tmp/r1.jsonl",
    startedAt: at(3 * 3_600_000 + 65_000),
    endedAt: at(3 * 3_600_000),
    result: null,
    error: null,
    ...patch,
  };
}

const result: RouteRunSummary["result"] = {
  runId: "r1",
  router: "capacity",
  complete: ["a", "b", "c"],
  open: ["d"],
  timedOut: false,
  stats: { vias: 4, segments: 20, wallMs: 65_000, frames: 40 },
};

describe("runTitle", () => {
  test("summarises the result, or the status when there is none", () => {
    expect(runTitle(run({ result }))).toBe("3/4 routed, 1 open");
    expect(runTitle(run({ result: { ...result, open: [] } }))).toBe("3/3 routed");
    expect(runTitle(run({ status: "running", endedAt: null }))).toBe("Routing…");
    expect(runTitle(run({ status: "failed", error: "solver crashed" }))).toBe(
      "Failed: solver crashed",
    );
    expect(runTitle(run({ status: "failed" }))).toBe("Failed");
    expect(runTitle(run({ status: "cancelled" }))).toBe("Cancelled");
    expect(runTitle(run({ status: "queued", endedAt: null }))).toBe("Queued…");
    expect(runTitle(run({ status: "timed_out" }))).toBe("Timed out");
    expect(runTitle(run({}))).toBe("Done");
  });
});

describe("runDuration", () => {
  test("uses the end time when there is one, else now, and survives bad timestamps", () => {
    expect(runDuration(run({}), NOW)).toBe("1m 05s");
    expect(runDuration(run({ status: "running", endedAt: null, startedAt: at(20_000) }), NOW)).toBe(
      "20s",
    );
    expect(runDuration(run({ startedAt: "nope" }), NOW)).toBe("");
    expect(runDuration(run({ endedAt: "nope" }), NOW)).toBe("");
  });
});

test("describeRun joins router, duration and age, and flags a live run", () => {
  const row = describeRun(run({ result }), NOW);
  expect(row).toEqual({
    id: "r1",
    title: "3/4 routed, 1 open",
    subtitle: "capacity · 1m 05s · 3h ago",
    status: "completed",
    tone: "success",
    live: false,
  });
  expect(describeRun(run({ status: "running", endedAt: null }), NOW)).toMatchObject({
    live: true,
    tone: "default",
  });
  expect(describeRun(run({ status: "failed" }), NOW).tone).toBe("danger");
  expect(describeRun(run({ status: "cancelled" }), NOW).tone).toBe("warning");
});

test("sortRuns puts running runs first, then newest first", () => {
  const runs = [
    run({ id: "old", startedAt: at(10 * 86_400_000) }),
    run({ id: "live", status: "running", endedAt: null, startedAt: at(5 * 86_400_000) }),
    run({ id: "new", startedAt: at(60_000) }),
  ];
  expect(sortRuns(runs).map((r) => r.id)).toEqual(["live", "new", "old"]);
  // Pure: the input order is untouched.
  expect(runs.map((r) => r.id)).toEqual(["old", "live", "new"]);
});
