import { describe, expect, test } from "bun:test";
import type { Thread } from "@fabdesk/protocol";
import { archivedThreads, branchInput, renamedTitle, threadMenuItems } from "./thread-actions";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p1",
  folderId: null,
  title: "Buck converter",
  pinned: false,
  archived: false,
  agentId: "claude",
  model: null,
  parentThreadId: null,
  branchFromMessageId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...over,
});

describe("threadMenuItems", () => {
  test("names the toggles after what they will do", () => {
    const labels = (t: Thread) => threadMenuItems(t).map((i) => i.label);
    expect(labels(thread())).toEqual(["Rename", "Pin", "Archive", "Branch from here", "Delete"]);
    expect(labels(thread({ pinned: true, archived: true }))).toEqual([
      "Rename",
      "Unpin",
      "Unarchive",
      "Branch from here",
      "Delete",
    ]);
  });

  test("only delete is destructive", () => {
    expect(
      threadMenuItems(thread())
        .filter((i) => i.destructive)
        .map((i) => i.action),
    ).toEqual(["delete"]);
  });
});

describe("renamedTitle", () => {
  test("trims, collapses whitespace and rejects no-ops", () => {
    expect(renamedTitle("  LDO   regulator ", "Buck converter")).toBe("LDO regulator");
    expect(renamedTitle("Buck converter", "Buck converter")).toBeNull();
    expect(renamedTitle("   ", "Buck converter")).toBeNull();
    expect(renamedTitle(undefined, "Buck converter")).toBeNull();
  });
});

describe("branchInput", () => {
  test("carries project, agent, model and the branch point", () => {
    expect(branchInput(thread({ model: "haiku" }), "m9")).toEqual({
      projectId: "p1",
      title: "Buck converter (branch)",
      agentId: "claude",
      model: "haiku",
      parentThreadId: "t1",
      branchFromMessageId: "m9",
    });
  });

  test("leaves model and branch point out when there is none, and shortens long titles", () => {
    const out = branchInput(thread({ title: "x".repeat(80) }), undefined);
    expect(out).not.toHaveProperty("model");
    expect(out).not.toHaveProperty("branchFromMessageId");
    expect(out.title).toBe(`${"x".repeat(49)}… (branch)`);
  });
});

describe("archivedThreads", () => {
  test("keeps only archived threads, newest first", () => {
    const list = [
      thread({ id: "a", archived: true, updatedAt: "2026-09-01T00:00:00.000Z" }),
      thread({ id: "b", archived: false }),
      thread({ id: "c", archived: true, updatedAt: "2026-09-03T00:00:00.000Z" }),
    ];
    expect(archivedThreads(list).map((t) => t.id)).toEqual(["c", "a"]);
  });
});
