import { describe, expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { appendDelta, appendPart, messagesKey } from "./events";

const base: Message = {
  id: "msg_1",
  threadId: "th_1",
  role: "assistant",
  contentMd: "",
  parts: [],
  runId: "run_1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("appendDelta", () => {
  test("grows the trailing part of the same kind instead of adding one", () => {
    const m = appendDelta(appendDelta(base, "text", "Hel"), "text", "lo");
    expect(m.parts).toEqual([{ type: "text", text: "Hello" }]);
    expect(m.contentMd).toBe("Hello");
  });

  test("starts a new part when the kind changes, and thinking stays out of contentMd", () => {
    const m = appendDelta(appendDelta(base, "text", "Hi"), "thinking", "hmm");
    expect(m.parts).toEqual([
      { type: "text", text: "Hi" },
      { type: "thinking", text: "hmm" },
    ]);
    expect(m.contentMd).toBe("Hi");
  });

  test("does not mutate the message it was given", () => {
    appendDelta(base, "text", "x");
    expect(base.parts).toEqual([]);
    expect(base.contentMd).toBe("");
  });
});

describe("appendPart", () => {
  test("a result replaces the placeholder carrying the same id", () => {
    const withUse = appendPart(base, {
      type: "tool_use",
      id: "t1",
      name: "render_board",
      input: {},
    });
    const pending = appendPart(withUse, { type: "tool_result", id: "t1", output: null });
    const done = appendPart(pending, { type: "tool_result", id: "t1", output: "ok" });
    expect(done.parts).toHaveLength(2);
    expect(done.parts[1]).toEqual({ type: "tool_result", id: "t1", output: "ok" });
  });

  test("results for different calls both stay", () => {
    let m = appendPart(base, { type: "tool_result", id: "t1", output: "a" });
    m = appendPart(m, { type: "tool_result", id: "t2", output: "b", isError: true });
    expect(m.parts).toHaveLength(2);
  });
});

test("messagesKey is the cache key the queries use", () => {
  expect(messagesKey("th_1")).toEqual(["messages", "th_1"]);
});
