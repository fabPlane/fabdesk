import { describe, expect, test } from "bun:test";
import type { ProjectSummary, Thread } from "@fabdesk/protocol";
import { groupThreadsByProject } from "./group-threads";

function thread(id: string, title: string, projectId: string | null, pinned = false): Thread {
  return {
    id,
    projectId,
    folderId: null,
    title,
    pinned,
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

  test("puts unassigned threads above project groups", () => {
    const groups = groupThreadsByProject(
      [thread("t1", "A", "p2"), thread("t2", "B", "p1"), thread("t3", "C", null), thread("t4", "gone", "p1")],
      projects,
    );
    expect(groups.map((g) => g.title)).toEqual(["No project", "Amplifier", "Blinky"]);
    expect(groups.map((g) => g.kind)).toEqual(["unassigned", "project", "project"]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t3"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t2", "t4"]);
    expect(groups[0]?.projectId).toBeNull();
  });

  test("includes projects that have no threads yet", () => {
    const groups = groupThreadsByProject([thread("t1", "A", "p1")], projects);
    expect(groups.map((g) => g.title)).toEqual(["Amplifier", "Blinky"]);
    expect(groups.find((g) => g.projectId === "p2")?.threads).toEqual([]);
    expect(groups.find((g) => g.projectId === "p1")?.threads.map((t) => t.id)).toEqual(["t1"]);
  });

  test("puts pinned threads above unassigned and project groups", () => {
    const groups = groupThreadsByProject(
      [
        thread("u1", "loose", null),
        thread("p1t", "amp chat", "p1"),
        thread("pin-proj", "favorite board", "p2", true),
        thread("pin-free", "inbox", null, true),
      ],
      projects,
    );
    expect(groups.map((g) => g.kind)).toEqual(["pinned", "unassigned", "project", "project"]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["pin-proj", "pin-free"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["u1"]);
    expect(groups.find((g) => g.projectId === "p2")?.threads).toEqual([]);
    expect(groups.find((g) => g.projectId === "p1")?.threads.map((t) => t.id)).toEqual(["p1t"]);
  });

  test("skips archived threads but keeps empty projects", () => {
    const archived = { ...thread("x", "old", "p1", true), archived: true };
    const groups = groupThreadsByProject([archived], projects);
    expect(groups.map((g) => g.title)).toEqual(["Amplifier", "Blinky"]);
    expect(groups.every((g) => g.threads.length === 0)).toBe(true);
  });
});
