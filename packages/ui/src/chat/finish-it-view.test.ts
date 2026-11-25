import { describe, expect, test } from "bun:test";
import type { FinishItSession } from "@fabdesk/protocol";
import { finishItActive, finishItDisplayedMilestoneStatus, finishItMilestoneNote, finishItMilestoneTone, finishItNextStep, finishItSummary } from "./finish-it-view";

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

describe("final verification display", () => {
  const allDone = () => session({
    currentMilestone: "verify",
    milestones: session().milestones.map((m) => ({ ...m, status: "done", note: "Already complete" })),
  });

  test("passing reports keep verification in progress until the session finishes", () => {
    const active = allDone();
    expect(finishItSummary(active)).toBe("Finishing final checks…");
    expect(active.milestones.map((m) => finishItDisplayedMilestoneStatus(active, m))).toEqual([
      "done", "done", "done", "running",
    ]);
    const completed = { ...active, status: "completed" as const, currentMilestone: null };
    expect(finishItDisplayedMilestoneStatus(completed, completed.milestones[3]!)).toBe("done");
    expect(finishItSummary(completed)).toBe("All board checks complete.");
  });

  test("stopping stays busy and failed sessions show their error", () => {
    const stopping = { ...allDone(), status: "stopping" as const };
    expect(finishItDisplayedMilestoneStatus(stopping, stopping.milestones[3]!)).toBe("running");
    expect(finishItSummary(stopping)).toBe("Waiting for the agent to stop…");
    expect(finishItSummary({ ...allDone(), status: "failed", error: "Export failed" })).toBe("Export failed");
  });

  test("pre-existing skipped checks also wait for the active session", () => {
    const active = allDone();
    active.milestones = active.milestones.map((m) => ({ ...m, status: "skipped" }));
    expect(finishItDisplayedMilestoneStatus(active, active.milestones[3]!)).toBe("running");
    const partial = session();
    expect(partial.milestones.map((m) => finishItDisplayedMilestoneStatus(partial, m))).toEqual([
      "done", "done", "running", "pending",
    ]);
  });

  test("ended steps show their note; pending and running steps do not", () => {
    const failed = session({
      status: "failed",
      currentMilestone: "build",
      milestones: [
        { id: "schematic", label: "Finish schematic", status: "done", note: "Netlist has 355 components" },
        { id: "build", label: "Place footprints", status: "failed", note: "Board not built" },
        { id: "route", label: "Route copper", status: "pending", note: "Not routed" },
      ],
    });
    expect(failed.milestones.map((m) => finishItMilestoneNote(failed, m))).toEqual(["Netlist has 355 components", "Board not built", null]);
    const running = session();
    expect(finishItMilestoneNote(running, running.milestones[2]!)).toBeNull();
  });

  test("a session that ended with steps left says how to continue", () => {
    expect(finishItNextStep(session({ status: "failed" }))).toContain("Completed steps are saved");
    expect(finishItNextStep(session({ status: "stopped", milestones: [{ id: "build", label: "Place footprints", status: "failed" }] }))).toContain("to retry");
    expect(finishItNextStep(session())).toBeNull();
    expect(finishItNextStep(session({ status: "completed" }))).toBeNull();
  });
});
