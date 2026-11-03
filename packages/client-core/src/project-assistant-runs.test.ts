import { expect, test } from "bun:test";
import { Thread } from "@fabdesk/protocol";
import { projectAssistantRuns } from "./project-assistant-runs";

function thread(id: string, projectId: string) {
  return Thread.parse({ id, projectId, agentId: "codex", model: null, title: id, createdAt: "", updatedAt: "", pinned: false, archived: false, folderId: null, parentThreadId: null, branchFromMessageId: null });
}
const run = (threadId: string, startedAt = 1) => ({ threadId, runId: `run-${threadId}`, agentId: "codex" as const, startedAt });

test("project activity includes only live runs with matching verified project membership", () => {
  const result = projectAssistantRuns("one", [thread("a", "one"), thread("b", "two"), thread("done", "one")], {
    a: run("a"), b: run("b"), unknown: run("unknown"),
  });
  expect(result.map(item => item.thread.id)).toEqual(["a"]);
  expect(result[0]?.run.runId).toBe("run-a");
});

test("stale placeholders and mismatched run ownership cannot claim another project's activity", () => {
  expect(projectAssistantRuns("two", [thread("a", "one")], { a: run("a") })).toEqual([]);
  expect(projectAssistantRuns("one", [thread("a", "one")], { a: run("different-thread") })).toEqual([]);
  expect(projectAssistantRuns("one", [], { a: run("a") })).toEqual([]);
});

test("running conversations retain their titles and sort by start time without duplicating tool jobs", () => {
  const result = projectAssistantRuns("one", [thread("later", "one"), thread("first", "one")], { later: run("later", 2), first: run("first", 1) });
  expect(result.map(item => item.thread.title)).toEqual(["first", "later"]);
});
