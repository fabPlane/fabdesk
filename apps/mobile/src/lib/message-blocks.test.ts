import { describe, expect, test } from "bun:test";
import type { MessagePart } from "@fabdesk/protocol";
import { summarizeTools, toBlocks } from "./message-blocks";

const text = (t: string): MessagePart => ({ type: "text", text: t });
const use = (id: string, name: string): MessagePart => ({ type: "tool_use", id, name, input: {} });
const result = (id: string, isError?: boolean): MessagePart => ({
  type: "tool_result",
  id,
  output: "ok",
  ...(isError === undefined ? {} : { isError }),
});

describe("toBlocks", () => {
  test("folds a run of tool calls into one block between the text around it", () => {
    const blocks = toBlocks([
      text("before"),
      use("1", "circuit_build"),
      result("1"),
      use("2", "route_run"),
      result("2"),
      text("after"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "tools", "text"]);
    expect(blocks[1]!.kind === "tools" && blocks[1]!.parts).toHaveLength(4);
  });

  test("text between two tool runs breaks them into separate blocks", () => {
    const blocks = toBlocks([
      use("1", "a"),
      result("1"),
      text("thinking out loud"),
      use("2", "b"),
      result("2"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["tools", "text", "tools"]);
  });

  test("marks only the final text block as last, which is where the caret goes", () => {
    const blocks = toBlocks([text("one"), text("two")]);
    expect(blocks.map((b) => b.kind === "text" && b.last)).toEqual([false, true]);
  });

  test("a trailing tool block means no text is last", () => {
    const blocks = toBlocks([text("one"), use("1", "a")]);
    expect(blocks[0]!.kind === "text" && blocks[0]!.last).toBe(false);
  });

  test("keeps thinking and images as their own blocks", () => {
    const blocks = toBlocks([
      { type: "thinking", text: "hmm" },
      { type: "image", path: "sketches/a.png", mime: "image/png" },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "image"]);
  });

  test("an empty message has no blocks", () => {
    expect(toBlocks([])).toEqual([]);
  });

  test("an approval request is its own card and closes the tool group before it", () => {
    const blocks = toBlocks([
      use("1", "circuit_build"),
      result("1"),
      {
        type: "approval",
        requestId: "a1",
        tool: "Bash",
        input: { command: "ls" },
        summary: "Run ls",
        decision: "pending",
      },
      use("2", "route_run"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["tools", "approval", "tools"]);
    expect(blocks[1]!.kind === "approval" && blocks[1]!.part.requestId).toBe("a1");
  });

  test("a question is a card too", () => {
    const blocks = toBlocks([
      text("hmm"),
      { type: "question", requestId: "q1", question: "Which?", options: ["a"], answer: null },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "question"]);
  });
});

describe("summarizeTools", () => {
  test("names a single call", () => {
    expect(summarizeTools([use("1", "render_board"), result("1")])).toMatchObject({
      label: "render_board",
      errors: 0,
      pending: false,
    });
  });

  test("counts several and shows the most recent two", () => {
    const s = summarizeTools([
      use("1", "a"),
      result("1"),
      use("2", "b"),
      result("2"),
      use("3", "c"),
      result("3"),
    ]);
    expect(s.label).toBe("3 tool calls · b, c");
  });

  test("is pending while a call has no result yet", () => {
    expect(summarizeTools([use("1", "route_run")]).pending).toBe(true);
  });

  test("counts failures", () => {
    expect(
      summarizeTools([use("1", "a"), result("1", true), use("2", "b"), result("2")]).errors,
    ).toBe(1);
  });

  test("handles orphan results, which arrive when a run is resumed mid-flight", () => {
    expect(summarizeTools([result("1")])).toMatchObject({ label: "tool results", pending: false });
  });
});
