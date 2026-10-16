import { expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { splitCompletedActivity } from "./completed-activity";
const message: Message = { id: "a", threadId: "t", role: "assistant", runId: "r", createdAt: "2026-10-16T00:00:00Z", contentMd: "", parts: [
  { type: "text", text: "I’ll inspect it." },
  { type: "tool_use", id: "cmd", name: "command_execution", input: {} },
  { type: "tool_result", id: "cmd", output: "done" },
  { type: "text", text: "Your board is ready." },
  { type: "image", path: "board.png", mime: "image/png" },
] };
test("history contains progress and commands, while final text and images stay outside", () => {
  const result = splitCompletedActivity([message]);
  expect(result.history[0]?.parts).toHaveLength(3);
  expect(result.answer?.contentMd).toBe("Your board is ready.");
  expect(result.answer?.parts.at(-1)?.type).toBe("image");
  expect(message.parts).toHaveLength(5);
});
test("multiple messages retain their IDs for search; only the final message becomes the answer", () => {
  const result = splitCompletedActivity([{ ...message, id: "progress", parts: [], contentMd: "Checking" }, message]);
  expect(result.history.map(m => m.id)).toEqual(["progress", "a"]);
  expect(result.answer?.id).toBe("a");
});
test("tool-only endings and interrupted runs never fabricate an answer", () => {
  expect(splitCompletedActivity([{ ...message, parts: message.parts.slice(0, 3) }]).answer).toBeNull();
  expect(splitCompletedActivity([message], true).answer).toBeNull();
});
test("plain-text responses are preserved without guessing sentence boundaries", () => {
  const plain = { ...message, parts: [], contentMd: "Complete answer" };
  expect(splitCompletedActivity([plain])).toEqual({ history: [], answer: plain });
});
