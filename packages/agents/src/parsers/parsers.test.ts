import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseJsonlLine } from "../jsonl";
import type { AgentEvent } from "../types";
import { CodexStreamParser } from "./codex";
import { CursorStreamParser } from "./cursor";
import { MessagesStreamParser } from "./messages";

const FIXTURES = join(import.meta.dir, "..", "__fixtures__");

async function fixtureLines(name: string): Promise<unknown[]> {
  const text = await Bun.file(join(FIXTURES, name)).text();
  return text
    .split("\n")
    .map(parseJsonlLine)
    .filter((v) => v !== undefined);
}

function feedAll(parser: { feed(line: unknown): AgentEvent[] }, lines: unknown[]): AgentEvent[] {
  return lines.flatMap((l) => parser.feed(l));
}

function joined(events: AgentEvent[], type: "text" | "thinking"): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: typeof type }> => e.type === type)
    .map((e) => e.delta)
    .join("");
}

describe("MessagesStreamParser (claude, recorded)", () => {
  test("hello run: init, single text emission, usage, failed MCP surfaced", async () => {
    const parser = new MessagesStreamParser();
    const events = feedAll(parser, await fixtureLines("claude-hello.jsonl"));
    const init = events.find((e) => e.type === "init");
    expect(init).toEqual({
      type: "init",
      sessionId: "924ee35a-5aa2-4770-b00b-373499b574f0",
      model: "claude-opus-5[1m]",
      mcpServers: [{ name: "fabdesk", status: "failed" }],
    });
    expect(
      events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message),
    ).toEqual(['MCP server "fabdesk" failed to connect']);
    // Delta and the whole assistant message both carry "Hello!": emitted exactly once.
    expect(joined(events, "text")).toBe("Hello!");
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      inputTokens: 34231,
      outputTokens: 6,
      costUsd: 0.343422,
    });
    expect(parser.sessionId).toBe("924ee35a-5aa2-4770-b00b-373499b574f0");
  });

  test("write run: tool_use from assistant message, tool_result from user message, no duplicates", async () => {
    const events = feedAll(new MessagesStreamParser(), await fixtureLines("claude-write.jsonl"));
    const uses = events.filter((e) => e.type === "tool_use");
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ id: "toolu_01PiziCMGqin77nYVV8Ho37R", name: "Write" });
    expect((uses[0] as { input: { content: string } }).input.content).toBe("hi\n");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "toolu_01PiziCMGqin77nYVV8Ho37R" });
    expect(String((results[0] as { output: unknown }).output)).toContain(
      "File created successfully",
    );
    expect(joined(events, "text")).toBe("done");
    // Order: tool_use before tool_result before the final text.
    const order = events
      .map((e) => e.type)
      .filter((t) => t === "tool_use" || t === "tool_result" || t === "text");
    expect(order).toEqual(["tool_use", "tool_result", "text"]);
  });

  test("without partial messages the whole assistant text is emitted once", () => {
    const parser = new MessagesStreamParser();
    const events = feedAll(parser, [
      {
        type: "system",
        subtype: "init",
        session_id: "s1",
        model: "m",
        mcp_servers: [{ name: "fabdesk", status: "connected" }],
      },
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Hi there" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s1",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ]);
    expect(joined(events, "thinking")).toBe("hmm");
    expect(joined(events, "text")).toBe("Hi there");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  test("error results and mcp_server_errors become error events", () => {
    const events = feedAll(new MessagesStreamParser(), [
      {
        type: "system",
        subtype: "init",
        session_id: "s1",
        mcp_servers: [],
        mcp_server_errors: [
          { name: "fabdesk", type: "url_missing_type", message: "url entry has no type" },
        ],
      },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"],
        session_id: "s1",
      },
    ]);
    const messages = events
      .filter((e) => e.type === "error")
      .map((e) => (e as { message: string }).message);
    expect(messages[0]).toContain("url_missing_type");
    expect(messages[1]).toBe("boom");
  });
});

describe("MessagesStreamParser (grok, recorded)", () => {
  test("hello run: thinking + text deltas streamed, assistant message not re-emitted", async () => {
    const parser = new MessagesStreamParser();
    const events = feedAll(parser, await fixtureLines("grok-hello.jsonl"));
    expect(events[0]).toMatchObject({
      type: "init",
      model: "grok-4.6",
      sessionId: "01a06064-a0ed-7500-83e6-5e4f1921bb03",
    });
    expect(joined(events, "thinking")).toBe(
      "The user wants me to say hello in one short sentence, then stop. This is a simple request - I should just greet them briefly and not do anything else.",
    );
    expect(joined(events, "text")).toBe("Hello — good to meet you.");
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      costUsd: 0.00388008,
      outputTokens: 47,
    });
  });

  test("write run: tool_use/tool_result pair, second message text once", async () => {
    const events = feedAll(new MessagesStreamParser(), await fixtureLines("grok-write.jsonl"));
    const uses = events.filter((e) => e.type === "tool_use");
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({
      name: "write",
      id: "call-be706c7c-0fb1-44ce-9bc6-22c3c4774bdb-0",
    });
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "call-be706c7c-0fb1-44ce-9bc6-22c3c4774bdb-0" });
    expect((results[0] as { isError?: boolean }).isError).toBeUndefined();
    expect(joined(events, "text")).toBe("I'll create `hello.txt` with the word `hi`.done");
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  test("cancelled tool results are flagged as errors", () => {
    const events = feedAll(new MessagesStreamParser(), [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "User cancelled",
              is_error: true,
            },
          ],
        },
      },
    ]);
    expect(events).toEqual([
      { type: "tool_result", id: "call-1", output: "User cancelled", isError: true },
    ]);
  });
});

describe("CodexStreamParser", () => {
  test("model-switch advisories preserve the reply without failing a successful turn", () => {
    const notice = "This session was recorded with model `gpt-6.1-sol` but is resuming with `gpt-6-astra`. Consider switching back to `gpt-6.1-sol` as it may affect Codex performance.";
    for (const event of [{ type: "error", message: notice }, { type: "item.completed", item: { id: "notice", type: "error", message: notice } }]) {
      const parser = new CodexStreamParser();
      const events = feedAll(parser, [event, { type: "item.completed", item: { id: "reply", type: "agent_message", text: "Ready." } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]);
      expect(events.filter(item => item.type === "error")).toHaveLength(0);
      expect(joined(events, "text")).toBe(`⚠ ${notice}\n\nReady.`);
      expect(parser.feed({ type: "turn.failed", error: { message: notice } })).toEqual([{ type: "error", message: notice }]);
      expect(parser.feed({ type: "error", message: "The selected model is not supported" })).toEqual([{ type: "error", message: "The selected model is not supported" }]);
    }
  });

  test("recorded file-change run", async () => {
    const parser = new CodexStreamParser();
    const events = feedAll(parser, await fixtureLines("codex-file-change.jsonl"));
    expect(events[0]).toEqual({ type: "init", sessionId: "01a06065-f87f-7493-91f2-292d4490f668" });
    expect(joined(events, "text")).toBe("I’ll create the requested file now.done");
    const uses = events.filter((e) => e.type === "tool_use");
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ id: "item_1", name: "file_change" });
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "item_1", output: { status: "completed" } });
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 37731, outputTokens: 75 });
    expect(parser.sessionId).toBe("01a06065-f87f-7493-91f2-292d4490f668");
  });

  test("recorded hello run", async () => {
    const events = feedAll(new CodexStreamParser(), await fixtureLines("codex-hello.jsonl"));
    expect(events.map((e) => e.type)).toEqual(["init", "text", "usage"]);
  });

  test("synthetic: mcp tool call, command execution, incremental reasoning, failures", () => {
    const events = feedAll(new CodexStreamParser(), [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_0", type: "reasoning", text: "Think" } },
      { type: "item.updated", item: { id: "item_0", type: "reasoning", text: "Thinking hard" } },
      { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Thinking hard" } },
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "fabdesk",
          tool: "circuit_build",
          arguments: { project: "p" },
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "fabdesk",
          tool: "circuit_build",
          arguments: { project: "p" },
          status: "completed",
          result: { content: [{ type: "text", text: "ok" }] },
        },
      },
      {
        type: "item.started",
        item: {
          id: "item_2",
          type: "command_execution",
          command: "bash -lc ls",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_2",
          type: "command_execution",
          command: "bash -lc ls",
          aggregated_output: "a\nb\n",
          exit_code: 1,
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_3",
          type: "mcp_tool_call",
          server: "fabdesk",
          tool: "route",
          arguments: {},
          status: "failed",
          error: { message: "router crashed" },
        },
      },
      { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Sorry." } },
      { type: "item.completed", item: { id: "item_5", type: "todo_list", items: [] } },
      { type: "turn.failed", error: { message: "turn exploded" } },
      { type: "error", message: "fatal" },
    ]);
    expect(joined(events, "thinking")).toBe("Thinking hard");
    expect(
      events.filter((e) => e.type === "tool_use").map((e) => (e as { name: string }).name),
    ).toEqual(["mcp__fabdesk__circuit_build", "command_execution", "mcp__fabdesk__route"]);
    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(results.map((r) => r.id)).toEqual(["item_1", "item_2", "item_3"]);
    expect(results[0]?.isError).toBeUndefined();
    expect(results[1]).toMatchObject({
      isError: true,
      output: { exit_code: 1, aggregated_output: "a\nb\n" },
    });
    expect(results[2]).toMatchObject({ isError: true, output: { message: "router crashed" } });
    expect(
      events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message),
    ).toEqual(["turn exploded", "fatal"]);
    expect(joined(events, "text")).toBe("Sorry.");
  });
});

describe("CursorStreamParser", () => {
  test("synthetic stream-json with partial output", () => {
    const parser = new CursorStreamParser();
    const events = feedAll(parser, [
      {
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        cwd: "/p",
        session_id: "c1",
        model: "Claude 4.5 Sonnet",
        permissionMode: "default",
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "make a file" }] },
        session_id: "c1",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "I'll " }] },
        session_id: "c1",
        timestamp_ms: 1,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "write it." }] },
        session_id: "c1",
        timestamp_ms: 2,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "I'll write it." }] },
        session_id: "c1",
        timestamp_ms: 3,
        model_call_id: "m1",
      },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "call_1",
        tool_call: {
          writeToolCall: { args: { path: "hello.txt", fileText: "hi", toolCallId: "call_1" } },
        },
        session_id: "c1",
      },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "call_1",
        tool_call: {
          writeToolCall: {
            args: { path: "hello.txt", fileText: "hi" },
            result: { success: { path: "/p/hello.txt", linesCreated: 1, fileSize: 2 } },
          },
        },
        session_id: "c1",
      },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "call_2",
        tool_call: { function: { name: "fabdesk_circuit_build", arguments: '{"project":"p"}' } },
        session_id: "c1",
      },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "call_2",
        tool_call: {
          function: { name: "fabdesk_circuit_build", arguments: '{"project":"p"}' },
          result: { error: "boom" },
        },
        session_id: "c1",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        session_id: "c1",
        timestamp_ms: 4,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        session_id: "c1",
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 9,
        is_error: false,
        result: "done",
        session_id: "c1",
      },
    ]);
    expect(events[0]).toEqual({ type: "init", sessionId: "c1", model: "Claude 4.5 Sonnet" });
    expect(joined(events, "text")).toBe("I'll write it.done");
    const uses = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_use" }> => e.type === "tool_use",
    );
    expect(uses.map((u) => [u.id, u.name])).toEqual([
      ["call_1", "write"],
      ["call_2", "fabdesk_circuit_build"],
    ]);
    expect(uses[1]?.input).toEqual({ project: "p" });
    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.isError).toBeUndefined();
    expect(results[1]?.isError).toBe(true);
    expect(parser.sessionId).toBe("c1");
  });

  test("without partial output each assistant message is emitted once; error results surface", () => {
    const events = feedAll(new CursorStreamParser(), [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "one" }] },
        session_id: "c1",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
        session_id: "c1",
      },
      {
        type: "result",
        subtype: "error",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        result: "quota exceeded",
        session_id: "c1",
      },
    ]);
    expect(joined(events, "text")).toBe("onetwo");
    expect(events.at(-1)).toEqual({ type: "error", message: "quota exceeded" });
  });
});
