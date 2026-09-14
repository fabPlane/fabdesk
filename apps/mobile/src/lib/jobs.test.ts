import { describe, expect, test } from "bun:test";
import type { Job } from "@fabdesk/protocol";
import type { LiveJob } from "@fabdesk/client-core";
import { activeCount, describeKind, jobDurationMs, jobsFor, mergeJobs } from "./jobs";

const listed = (over: Partial<Job> & { id: string }): Job => ({
  kind: "render_board",
  projectId: "p1",
  status: "done",
  progress: 1,
  note: null,
  result: null,
  error: null,
  startedAt: "2026-09-12T10:00:00Z",
  endedAt: "2026-09-12T10:00:30Z",
  ...over,
});

const live = (over: Partial<LiveJob> & { jobId: string }): LiveJob => ({
  kind: "route_run",
  status: "running",
  startedAt: Date.parse("2026-09-12T11:00:00Z"),
  ...over,
});

describe("mergeJobs", () => {
  test("live status overrides the listed one, and a live-only job is included", () => {
    const rows = mergeJobs(
      [listed({ id: "a", status: "running", endedAt: null }), listed({ id: "b" })],
      {
        a: live({ jobId: "a", kind: "render_board", status: "done", progress: 1, note: "written" }),
        c: live({ jobId: "c", projectId: "p2" }),
      },
    );
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["c", "running"],
      ["a", "done"],
      ["b", "done"],
    ]);
    expect(rows.find((r) => r.id === "a")).toMatchObject({
      note: "written",
      progress: 1,
      endedAt: null,
    });
    expect(rows.find((r) => r.id === "c")).toMatchObject({ kind: "route_run", projectId: "p2" });
  });

  test("active first, then newest first; a listed job going live keeps its listed fields", () => {
    const rows = mergeJobs(
      [
        listed({ id: "old", startedAt: "2026-09-12T08:00:00Z" }),
        listed({ id: "new", startedAt: "2026-09-12T09:00:00Z" }),
        listed({ id: "q", status: "queued", startedAt: null, endedAt: null }),
      ],
      {
        new: live({
          jobId: "new",
          kind: "render_board",
          status: "running",
          startedAt: Date.parse("2026-09-12T09:00:00Z"),
        }),
      },
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "q", "old"]);
    expect(rows[0]?.projectId).toBe("p1");
    expect(rows[0]?.endedAt).toBeNull();
  });

  test("no list yet is fine", () => {
    expect(mergeJobs(undefined, {})).toEqual([]);
    expect(mergeJobs(undefined, { x: live({ jobId: "x" }) })).toHaveLength(1);
  });
});

describe("helpers", () => {
  const rows = mergeJobs(
    [listed({ id: "a" }), listed({ id: "b", projectId: "p2", status: "running", endedAt: null })],
    {},
  );

  test("duration: ended jobs by their end, running by now, unstarted null", () => {
    expect(jobDurationMs(rows.find((r) => r.id === "a")!, 0)).toBe(30_000);
    const now = Date.parse("2026-09-12T10:01:00Z");
    expect(jobDurationMs(rows.find((r) => r.id === "b")!, now)).toBe(60_000);
    expect(
      jobDurationMs(mergeJobs([listed({ id: "q", startedAt: null, endedAt: null })], {})[0]!, now),
    ).toBeNull();
  });

  test("kind wording, per-project filter, active count", () => {
    expect(describeKind("render_board")).toBe("render board");
    expect(jobsFor(rows, "p2").map((r) => r.id)).toEqual(["b"]);
    expect(activeCount(rows)).toBe(1);
  });
});
