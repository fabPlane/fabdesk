/** board_check's workflow status: the one next step, in the order opens > regressions > review > old failures > release. */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptRun } from "@fabdesk/board-workflow";
import { statusLines, workflowStatus } from "../src/tools/board-status";

const CODES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"] as const;
const run = (failing: string[], regressed: string[] = [], designHash = "d1"): AcceptRun =>
  ({
    entry: { designHash, summary: Object.fromEntries(CODES.map((c) => [c, !failing.includes(c)])) },
    baseline: regressed.length ? { newFailures: regressed } : null,
  }) as unknown as AcceptRun;

describe("workflowStatus", () => {
  test("opens come first, then what got worse since onboarding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-status-"));
    expect((await workflowStatus(dir, run(["A1", "A7"], ["A7"]))).next).toMatch(/^close the open connections: board_route/);
    const s = await workflowStatus(dir, run(["A7"], ["A7"]));
    expect(s.next).toMatch(/^fix what got worse since onboarding \(A7\): A7: board_route .*a7/);
  });
  test("with no review the next step is the review; a release of another design is not current", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-status-"));
    await mkdir(join(dir, "exports", "release-20261113-010000"), { recursive: true });
    await writeFile(join(dir, "exports", "release-20261113-010000", "acceptance-gate.json"), JSON.stringify({ designHash: "old" }));
    const s = await workflowStatus(dir, run([]));
    expect(s.review).toBeNull();
    expect(s.release).toEqual({ package: "exports/release-20261113-010000", current: false });
    expect(s.next).toMatch(/^review this design: board_review/);
    const lines = statusLines(s);
    expect(lines[0]).toContain("Release: exports/release-20261113-010000 (an older design)");
    expect(lines.join("\n")).toContain("Task:");
    expect(lines.join("\n")).toContain("Recommended next:");
    expect(lines.join("\n")).not.toMatch(/^Next:/m);
  });
});

test("a current review and an older release report three separate stages", async () => {
  const { currentReviewHash } = await import("@fabdesk/board-workflow");
  const { recordReviewGate } = await import("../src/board-state");
  const dir = await mkdtemp(join(tmpdir(), "status-current-"));
  await writeFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)");
  const hash = await currentReviewHash(dir);
  await mkdir(join(dir, ".fabdesk/board/review/runs/current"), { recursive: true });
  await writeFile(join(dir, ".fabdesk/board/review/latest.json"), JSON.stringify({ run: "current" }));
  await writeFile(join(dir, ".fabdesk/board/review/runs/current/review.json"), JSON.stringify({ hash, pcb: "board.kicad_pcb", checks: [], findings: [] }));
  await recordReviewGate(dir, { current: true, open: 0, mustFix: 0 });
  await mkdir(join(dir, "exports/release-old"), { recursive: true });
  await writeFile(join(dir, "exports/release-old/acceptance-gate.json"), JSON.stringify({ reviewDesignHash: "older" }));
  const s = await workflowStatus(dir, run([]));
  expect(s.review?.state).toBe("current");
  expect(s.release?.current).toBe(false);
  const lines = statusLines(s).join("\n");
  for (const stage of ["Task:", "Review:", "Release:"]) expect(lines).toContain(stage);
  expect(lines).not.toMatch(/^Next:/m);
  expect(lines.match(/Recommended next:/g)).toHaveLength(1);
});
