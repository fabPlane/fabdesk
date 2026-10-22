import { expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { deduplicateChatNotices } from "./chat-notices";

const notice = "⚠ Windows denied a Codex overlay symlink (EPERM). Using the original CODEX_HOME and live credential store; per-project config isolation is unavailable.";
const message = (id: string, text: string): Message => ({
  id, threadId: "chat", role: "assistant", runId: id, createdAt: "2026-10-19T00:00:00Z",
  contentMd: text, parts: [{ type: "text", text }],
});

test("saved and streaming replies show the setup warning once without losing answers or questions", () => {
  const first = message("first", `${notice}\n\nFirst reply`);
  const second = message("second", `${notice}\n\nSecond reply\n\n⚠ Failed to authenticate: expired`);
  const stream = message("stream", `${notice}\n\n`);
  const input = [first, second, stream];
  const result = deduplicateChatNotices(input);
  expect(result[0]).toBe(first);
  expect(result[1]?.contentMd).toBe("Second reply\n\n⚠ Failed to authenticate: expired");
  expect(result[1]?.parts).toEqual([{ type: "text", text: "Second reply\n\n⚠ Failed to authenticate: expired" }]);
  expect(result[2]?.contentMd).toBe("");
  expect(second.contentMd).toContain(notice);
  expect(deduplicateChatNotices(input)).toEqual(result); // Reopening a chat needs no in-memory flag.
  expect(deduplicateChatNotices([...input.slice(0, 2), message("stream", `${notice}\n\nNew answer`)])[2]?.contentMd).toBe("New answer");
});

test("user quotations, tool output, other warnings, and separate chats remain intact", () => {
  const user = { ...message("user", notice), role: "user" as const };
  const first = message("first", notice);
  const tool = { ...message("tool", ""), parts: [{ type: "tool_result" as const, id: "t", output: notice }] };
  const other = { ...message("other", notice), threadId: "another-chat" };
  const input = [user, first, tool, other];
  expect(deduplicateChatNotices(input)).toEqual(input);
});

test("plain text history and separate text parts are both deduplicated", () => {
  const first = { ...message("first", notice), parts: [] };
  const second = { ...message("second", `${notice}\n\nAnswer`), parts: [
    { type: "text" as const, text: `${notice}\n\n` },
    { type: "text" as const, text: "Answer" },
  ] };
  const result = deduplicateChatNotices([first, second]);
  expect(result[0]).toBe(first);
  expect(result[1]?.parts).toEqual([{ type: "text", text: "" }, { type: "text", text: "Answer" }]);
  expect(result[1]?.contentMd).toBe("Answer");
});
