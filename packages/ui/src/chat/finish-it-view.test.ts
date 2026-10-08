import { describe, expect, test } from "bun:test";
import type { FinishItSession } from "@fabdesk/protocol";
import { finishItActive, finishItMilestoneTone, finishItSummary } from "./finish-it-view";

const session = (patch: Partial<FinishItSession> = {}): FinishItSession => ({
  id: "fin_1",
  projectId: "p1",
  threadId: "th_1",
  runId: "run_1",
  status: "running",
  currentMilestone: "route",
  milestones: [
    {
      id: "schematic",
      label: "Finish schematic",
      status: "done",
      note: "Netlist has 3 components",
    },
    { id: "build", label: "Place footprints", status: "done" },
    { id: "route", label: "Route copper", status: "running", note: "4 open connections" },
    { id: "verify", label: "Verify DRC / ERC / SPICE", status: "pending" },
  ],
  commits: [],
  error: null,
  startedAt: "2026-10-08T00:00:00.000Z",
  endedAt: null,
  ...patch,
});

describe("finishIt view helpers", () => {
  test("active while running or stopping", () => {
    expect(finishItActive(session())).toBe(true);
    expect(finishItActive(session({ status: "stopping" }))).toBe(true);
    expect(finishItActive(session({ status: "completed" }))).toBe(false);
    expect(finishItActive(null)).toBe(false);
  });

  test("summary prefers the current milestone note", () => {
    expect(finishItSummary(session())).toBe("4 open connections");
    expect(finishItSummary(session({ status: "failed", error: "agent crashed", currentMilestone: null }))).toBe(
      "agent crashed",
    );
    expect(finishItMilestoneTone("skipped")).toBe("done");
    expect(finishItMilestoneTone("running")).toBe("running");
  });
});
