import { describe, expect, test } from "bun:test";
import type { Message, Thread } from "@fabdesk/protocol";
import { QueryClient } from "@tanstack/react-query";
import type { CoreClient } from "./CoreClient";
import {
  appendDelta,
  appendPart,
  handleCoreEvent,
  messagesKey,
  patchThreadCaches,
  reconcileLiveRuns,
} from "./events";

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

describe("thread lifecycle events", () => {
  const thread = (id: string, title: string): Thread => ({
    id,
    projectId: "p1",
    folderId: null,
    title,
    pinned: false,
    archived: false,
    agentId: "claude",
    model: null,
    parentThreadId: null,
    branchFromMessageId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  // A QueryClient with no observers: invalidation only marks queries stale, which is what the
  // tests read back through `getQueryState`.
  const setup = () => {
    const qc = new QueryClient();
    qc.setQueryData(["threads", "", ""], [thread("th_1", "New chat"), thread("th_2", "Other")]);
    qc.setQueryData(["threads", "", "p1"], [thread("th_1", "New chat")]);
    qc.setQueryData(["threads", "one", "th_1"], thread("th_1", "New chat"));
    qc.setQueryData(["thread", "th_1"], { ...thread("th_1", "New chat"), running: false });
    qc.setQueryData(messagesKey("th_1"), [base]);
    const ctx = { qc, client: {} as CoreClient };
    return { qc, ctx };
  };
  const titles = (qc: QueryClient, key: readonly unknown[]) =>
    (qc.getQueryData<Thread[]>(key) ?? []).map((t) => t.title);

  test("thread.created marks every thread list stale", () => {
    const { qc, ctx } = setup();
    handleCoreEvent({ topic: "thread.created", ts: 1, threadId: "th_3", projectId: "p1" }, ctx);
    expect(qc.getQueryState(["threads", "", ""])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["threads", "", "p1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["thread", "th_1"])?.isInvalidated).toBe(false);
  });

  test("thread.updated with a title patches every cached copy before the refetch", () => {
    const { qc, ctx } = setup();
    handleCoreEvent(
      { topic: "thread.updated", ts: 1, threadId: "th_1", title: "Blinky board" },
      ctx,
    );
    expect(titles(qc, ["threads", "", ""])).toEqual(["Blinky board", "Other"]);
    expect(titles(qc, ["threads", "", "p1"])).toEqual(["Blinky board"]);
    expect(qc.getQueryData<Thread>(["threads", "one", "th_1"])?.title).toBe("Blinky board");
    // The detail keeps its extra fields.
    expect(qc.getQueryData<Thread & { running: boolean }>(["thread", "th_1"])).toMatchObject({
      title: "Blinky board",
      running: false,
    });
    expect(qc.getQueryState(["threads", "", ""])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["thread", "th_1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(messagesKey("th_1"))?.isInvalidated).toBe(true);
  });

  test("thread.updated without a title leaves the rows alone and just invalidates", () => {
    const { qc, ctx } = setup();
    handleCoreEvent({ topic: "thread.updated", ts: 1, threadId: "th_1" }, ctx);
    expect(titles(qc, ["threads", "", ""])).toEqual(["New chat", "Other"]);
    expect(qc.getQueryState(["thread", "th_1"])?.isInvalidated).toBe(true);
  });

  test("thread.deleted drops the row from lists and forgets the detail and messages", () => {
    const { qc, ctx } = setup();
    handleCoreEvent({ topic: "thread.deleted", ts: 1, threadId: "th_1" }, ctx);
    expect(titles(qc, ["threads", "", ""])).toEqual(["Other"]);
    expect(titles(qc, ["threads", "", "p1"])).toEqual([]);
    expect(qc.getQueryData(["threads", "one", "th_1"])).toBeNull();
    expect(qc.getQueryState(["thread", "th_1"])).toBeUndefined();
    expect(qc.getQueryState(messagesKey("th_1"))).toBeUndefined();
    expect(qc.getQueryState(["threads", "", ""])?.isInvalidated).toBe(true);
  });

  test("patchThreadCaches ignores threads it was not asked about", () => {
    const { qc } = setup();
    patchThreadCaches(qc, "th_2", (t) => ({ ...t, pinned: true }));
    const list = qc.getQueryData<Thread[]>(["threads", "", ""]) ?? [];
    expect(list.map((t) => t.pinned)).toEqual([false, true]);
    expect(qc.getQueryData<Thread>(["thread", "th_1"])?.pinned).toBe(false);
  });
});

describe("supervised mode events", () => {
  const setup = () => {
    const qc = new QueryClient();
    qc.setQueryData(["thread", "th_1"], {
      id: "th_1",
      running: true,
      pending: { approvals: [], inputs: [] },
    });
    qc.setQueryData(messagesKey("th_1"), [
      { ...base, id: "msg_0", role: "user", runId: null, contentMd: "go" },
      {
        ...base,
        parts: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } }],
      },
    ]);
    return { qc, ctx: { qc, client: {} as CoreClient } };
  };
  const assistant = (qc: QueryClient) =>
    (qc.getQueryData<Message[]>(messagesKey("th_1")) ?? [])[1]!;
  const requested = {
    topic: "agent.approval_requested" as const,
    ts: 1,
    runId: "run_1",
    threadId: "th_1",
    requestId: "apr_1",
    tool: "Bash",
    input: { command: "rm -rf build" },
    summary: "Bash: rm -rf build",
  };

  test("a request lands on the run's assistant message as a pending part, once", () => {
    const { qc, ctx } = setup();
    handleCoreEvent(requested, ctx);
    handleCoreEvent(requested, ctx);
    expect(assistant(qc).parts).toEqual([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } },
      {
        type: "approval",
        requestId: "apr_1",
        tool: "Bash",
        input: { command: "rm -rf build" },
        summary: "Bash: rm -rf build",
        decision: "pending",
      },
    ]);
    // The user message is not the run's and stays untouched; the detail (with `pending`) is stale.
    expect((qc.getQueryData<Message[]>(messagesKey("th_1")) ?? [])[0]!.parts).toEqual([]);
    expect(qc.getQueryState(["thread", "th_1"])?.isInvalidated).toBe(true);
  });

  test("a decision patches the part in place", () => {
    const { qc, ctx } = setup();
    handleCoreEvent(requested, ctx);
    handleCoreEvent(
      {
        topic: "agent.approval_resolved",
        ts: 2,
        runId: "run_1",
        threadId: "th_1",
        requestId: "apr_1",
        decision: "deny",
        by: "device",
      },
      ctx,
    );
    expect(assistant(qc).parts[1]).toMatchObject({
      type: "approval",
      requestId: "apr_1",
      decision: "deny",
    });
    expect(assistant(qc).parts).toHaveLength(2);
    // A decision for a request this cache never saw is a no-op, not a crash.
    handleCoreEvent(
      {
        topic: "agent.approval_resolved",
        ts: 3,
        runId: "run_1",
        threadId: "th_1",
        requestId: "apr_9",
        decision: "approve",
        by: "desktop",
      },
      ctx,
    );
    expect(assistant(qc).parts).toHaveLength(2);
  });

  test("questions: options are kept, the answer fills in", () => {
    const { qc, ctx } = setup();
    handleCoreEvent(
      {
        topic: "agent.input_requested",
        ts: 1,
        runId: "run_1",
        threadId: "th_1",
        requestId: "ask_1",
        question: "Layers?",
        options: ["2", "4"],
      },
      ctx,
    );
    handleCoreEvent(
      {
        topic: "agent.input_requested",
        ts: 1,
        runId: "run_1",
        threadId: "th_1",
        requestId: "ask_2",
        question: "Name?",
      },
      ctx,
    );
    expect(assistant(qc).parts.slice(1)).toEqual([
      {
        type: "question",
        requestId: "ask_1",
        question: "Layers?",
        options: ["2", "4"],
        answer: null,
      },
      { type: "question", requestId: "ask_2", question: "Name?", answer: null },
    ]);
    handleCoreEvent(
      {
        topic: "agent.input_resolved",
        ts: 2,
        runId: "run_1",
        threadId: "th_1",
        requestId: "ask_1",
        answer: "4",
      },
      ctx,
    );
    expect(assistant(qc).parts[1]).toMatchObject({ type: "question", answer: "4" });
    expect(assistant(qc).parts[2]).toMatchObject({ type: "question", answer: null });
    expect(qc.getQueryState(["thread", "th_1"])?.isInvalidated).toBe(true);
  });

  test("a request for a thread that is not cached is harmless", () => {
    const { qc, ctx } = setup();
    handleCoreEvent({ ...requested, threadId: "th_other" }, ctx);
    expect(assistant(qc).parts).toHaveLength(1);
    expect(qc.getQueryData<Message[]>(messagesKey("th_other"))).toEqual([]);
  });
});

describe("reconcileLiveRuns", () => {
  test("drops runs the daemon no longer reports as running and keeps the live ones", async () => {
    const ended: string[] = [];
    const runs = {
      runsByThread: {
        th_dead: {
          runId: "run_dead",
          threadId: "th_dead",
          agentId: "claude" as const,
          startedAt: 1,
        },
        th_live: {
          runId: "run_live",
          threadId: "th_live",
          agentId: "claude" as const,
          startedAt: 1,
        },
        th_gone: {
          runId: "run_gone",
          threadId: "th_gone",
          agentId: "claude" as const,
          startedAt: 1,
        },
      },
      endRun: (id: string) => ended.push(id),
    };
    const client = {
      getThread: async (id: string) => {
        if (id === "th_gone") throw new Error("404");
        return { id, running: id === "th_live" } as unknown as Thread;
      },
    };
    const dropped = await reconcileLiveRuns(client, runs);
    expect(dropped).toEqual(["th_dead"]);
    expect(ended).toEqual(["run_dead"]);
  });
});
