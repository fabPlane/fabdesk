import { describe, expect, test } from "bun:test";
import { CoreEvent } from "./events";
import { FinishItSession, FINISH_IT_MILESTONES } from "./finish-it";

const session = {
  id: "fin_1",
  projectId: "p1",
  threadId: "th_1",
  runId: null,
  status: "running" as const,
  currentMilestone: "schematic" as const,
  milestones: FINISH_IT_MILESTONES.map((id) => ({
    id,
    label: id,
    status: "pending" as const,
  })),
  commits: [],
  error: null,
  startedAt: "2026-10-08T00:00:00.000Z",
  endedAt: null,
};

describe("Finish it protocol", () => {
  test("session schema and finish_it events parse", () => {
    expect(FinishItSession.parse(session).id).toBe("fin_1");
    expect(CoreEvent.parse({ ts: 1, topic: "finish_it.started", session }).topic).toBe(
      "finish_it.started",
    );
    expect(
      CoreEvent.parse({
        ts: 1,
        topic: "finish_it.milestone",
        session,
        milestone: "build",
        commitSha: "abc",
      }).topic,
    ).toBe("finish_it.milestone");
    expect(
      CoreEvent.parse({ ts: 1, topic: "finish_it.failed", session, error: "nope" }).topic,
    ).toBe("finish_it.failed");
  });
});
