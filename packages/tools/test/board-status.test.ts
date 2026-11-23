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
    expect(lines[0]).toContain("release exports/release-20261113-010000 (an older design)");
    expect(lines[1]).toBe(`Next: ${s.next}`);
  });
});
