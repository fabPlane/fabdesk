import { expect, test } from "bun:test";
import type { Job } from "@fabdesk/protocol";
import { projectJobs, projectJobBoard } from "./project-jobs";

const job = (id: string, projectId = "a", status: Job["status"] = "running"): Job => ({ id, projectId, kind: "render_board", status, progress: null, note: null, error: null, result: null, startedAt: "2026-10-30T06:00:00Z", endedAt: null });
test("persisted jobs recover after navigation without exposing another project's tasks", () => {
  const rows = projectJobs("a", [job("a1"), job("b1", "b")], { hidden: { jobId: "hidden", kind: "render_glb", status: "running", startedAt: 1 } }, "local");
  expect(rows.map(row => row.id)).toEqual(["a1"]);
});
test("live progress fills an owned job and terminal persisted results cannot revert to running", () => {
  const rows = projectJobs("a", [job("done", "a", "done"), job("active")], {
    active: { jobId: "active", kind: "render_board", status: "running", progress: .4, startedAt: 1 },
    done: { jobId: "done", kind: "render_board", status: "running", startedAt: 1 },
  }, "local");
  expect(rows.map(row => row.status)).toEqual(["running", "done"]);
  expect(rows[0]?.progress).toBe(.4); expect(rows[1]?.progress).toBe(1);
});
test("a known live project can recover a job before the persisted list refreshes", () => {
  const rows = projectJobs("a", [], { a: { jobId: "a", projectId: "a", endpoint: "local", kind: "render_board", status: "running", progress: NaN, startedAt: 1 } }, "local");
  expect(rows).toHaveLength(1); expect(rows[0]?.progress).toBeNull();
});
test("job source metadata is not borrowed from another project's result", () => {
  const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
  expect(projectJobBoard({ ...job("j"), result: { json: { _board: { ...board, projectId: "b" } } } })).toBeNull();
  expect(projectJobBoard({ ...job("j"), result: { json: { _board: { ...board, projectId: "a" } } } })).toEqual(board);
  expect(projectJobBoard({ ...job("j"), board })).toEqual(board);
});

test("live jobs from another core cannot inherit an identical project ID", () => {
  const rows = projectJobs("a", [], { remote: { jobId: "remote", projectId: "a", endpoint: "remote", kind: "render_board", status: "running", startedAt: 1 } }, "local");
  expect(rows).toEqual([]);
});
