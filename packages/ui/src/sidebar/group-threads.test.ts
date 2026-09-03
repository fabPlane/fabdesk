import { describe, expect, test } from "bun:test";
import type { ProjectSummary, Thread } from "@fabdesk/protocol";
import { groupThreadsByProject } from "./group-threads";

function thread(id: string, title: string, projectId: string | null): Thread {
  return {
    id,
    projectId,
    folderId: null,
    title,
    pinned: false,
    archived: false,
    agentId: "claude",
    model: null,
    parentThreadId: null,
    branchFromMessageId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("groupThreadsByProject", () => {
  const projects: ProjectSummary[] = [
    { id: "p2", name: "Blinky", path: "/p2", createdAt: "", updatedAt: "" },
    { id: "p1", name: "Amplifier", path: "/p1", createdAt: "", updatedAt: "" },
  ];

  test("groups conversations under project names and sorts them", () => {
    const groups = groupThreadsByProject(
      [thread("t1", "A", "p2"), thread("t2", "B", "p1"), thread("t3", "C", null), thread("t4", "gone", "p1")],
      projects,
    );
    expect(groups.map((g) => g.title)).toEqual(["Amplifier", "Blinky", "No project"]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t2", "t4"]);
    expect(groups[2]?.projectId).toBeNull();
  });

  test("skips archived threads", () => {
    const archived = { ...thread("x", "old", "p1"), archived: true };
    expect(groupThreadsByProject([archived], projects)).toEqual([]);
  });
});
