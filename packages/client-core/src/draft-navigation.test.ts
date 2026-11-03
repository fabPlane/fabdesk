import { expect, test } from "bun:test";
import type { Message, Thread } from "@fabdesk/protocol";
import { activeQuestion, draftConversation, draftWorkspaceTitle } from "./draft-navigation";

const thread = (id: string, updatedAt: string, rest: Partial<Thread> = {}): Thread => ({ id, projectId: "p", folderId: null, title: id, archived: false, pinned: false, agentId: "codex", model: null, parentThreadId: null, branchFromMessageId: null, createdAt: "2026-11-03T00:00:00Z", updatedAt, ...rest });

test("resume and displayed title agree despite response ordering, other projects and archived chats", () => {
  const threads = [thread("older", "2026-11-03T00:00:00Z"), thread("foreign", "2026-11-05T00:00:00Z", { projectId: "other" }), thread("hidden", "2026-11-06T00:00:00Z", { archived: true }), thread("Desk light", "2026-11-04T00:00:00Z")];
  const original = threads.map(item => item.id);
  expect(draftConversation("p", threads)?.id).toBe("Desk light");
  expect(draftWorkspaceTitle({ id: "p", name: "Untitled idea", isDraft: true }, threads)).toBe("Desk light");
  expect(draftWorkspaceTitle({ id: "p", name: "My name", isDraft: true }, threads)).toBe("My name");
  expect(draftWorkspaceTitle({ id: "p", name: "Untitled idea", isDraft: false }, threads)).toBe("Untitled idea");
  expect(draftConversation("missing", threads)).toBeUndefined();
  expect(threads.map(item => item.id)).toEqual(original);
});

test("only the live assistant question can take focus or collapse the composer", () => {
  const message = (id: string, runId: string, answer: string | null, role: Message["role"] = "assistant"): Message => ({ id, runId, role, threadId: "t", contentMd: "", createdAt: "2026-11-03", parts: [{ type: "question", requestId: id, question: "Color?", options: ["Green"], answer }] });
  const messages = [message("old-unanswered", "old", null), message("user", "live", null, "user"), message("closed", "live", ""), message("answered", "live", "Green"), message("pending", "live", null)];
  expect(activeQuestion(messages, "live")?.requestId).toBe("pending");
  expect(activeQuestion(messages, undefined)).toBeUndefined();
  expect(activeQuestion(messages.slice(0, -1), "live")).toBeUndefined();
});
