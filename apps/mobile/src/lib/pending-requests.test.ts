import { describe, expect, test } from "bun:test";
import type { AgentInfo, Message, MessagePart } from "@fabdesk/protocol";
import {
  agentSupportsSupervised,
  bareToolName,
  cleanAnswer,
  decisionLabel,
  defaultRuntimeMode,
  inputDetail,
  inputPreview,
  newRequestIds,
  pendingCount,
  pendingFromThread,
  resolveInMessages,
  runtimeModeOf,
  runtimeModeOptions,
  unplacedPending,
  withoutRequest,
  type AnyPart,
  type PendingRequests,
} from "./pending-requests";

const agent = (over: Partial<AgentInfo> & { supportsSupervised?: boolean } = {}): AgentInfo =>
  ({
    id: "claude",
    displayName: "Claude Code",
    installed: true,
    installHint: "",
    models: [],
    ...over,
  }) as AgentInfo;

const msg = (id: string, parts: AnyPart[]): Message => ({
  id,
  threadId: "t1",
  role: "assistant",
  contentMd: "",
  parts: parts as MessagePart[],
  runId: "r1",
  createdAt: "2026-09-13T00:00:00Z",
});

const approvalPart = (
  requestId: string,
  decision: "pending" | "approve" | "deny" = "pending",
): AnyPart => ({
  type: "approval",
  requestId,
  tool: "Bash",
  input: { command: "rm -rf build" },
  summary: "Run rm -rf build",
  decision,
});

const pending: PendingRequests = {
  approvals: [{ requestId: "a1", tool: "Bash", input: { command: "ls" }, summary: "Run ls" }],
  inputs: [{ requestId: "q1", question: "Which layer?", options: ["top", "bottom"] }],
};

describe("runtime mode", () => {
  test("reads the thread's mode, treating a daemon without the field as full", () => {
    expect(runtimeModeOf(undefined)).toBe("full");
    expect(runtimeModeOf({ runtimeMode: "supervised" } as never)).toBe("supervised");
    expect(runtimeModeOf({} as never)).toBe("full");
  });

  test("defaults a new chat's mode from settings, full when the setting is missing", () => {
    expect(defaultRuntimeMode(undefined)).toBe("full");
    expect(defaultRuntimeMode({ defaultAgent: "claude" })).toBe("full");
    expect(defaultRuntimeMode({ defaultAgent: "claude", defaultRuntimeMode: "supervised" })).toBe(
      "supervised",
    );
  });

  test("a missing supportsSupervised flag means the agent cannot pause", () => {
    expect(agentSupportsSupervised(undefined)).toBe(false);
    expect(agentSupportsSupervised(agent())).toBe(false);
    expect(agentSupportsSupervised(agent({ supportsSupervised: true }))).toBe(true);
  });

  test("offers supervised disabled, with the reason, for an agent that cannot pause", () => {
    const rows = runtimeModeOptions("full", agent({ id: "grok", displayName: "Grok" }));
    expect(rows.map((r) => r.mode)).toEqual(["full", "supervised"]);
    expect(rows[0]).toMatchObject({ selected: true, disabled: false });
    expect(rows[1]).toMatchObject({ selected: false, disabled: true });
    expect(rows[1]!.hint).toContain("Grok cannot pause");
  });

  test("enables supervised and marks it selected when the thread is already in it", () => {
    const rows = runtimeModeOptions("supervised", agent({ supportsSupervised: true }));
    expect(rows[1]).toMatchObject({ selected: true, disabled: false });
    expect(rows[0]!.selected).toBe(false);
  });
});

describe("pendingFromThread", () => {
  test("reads the pending block off a thread response", () => {
    expect(pendingFromThread({ id: "t1", pending })).toEqual(pending);
  });

  test("an older daemon, or a malformed block, yields nothing pending", () => {
    expect(pendingFromThread({ id: "t1" })).toEqual({ approvals: [], inputs: [] });
    expect(pendingFromThread(null)).toEqual({ approvals: [], inputs: [] });
    expect(pendingFromThread({ pending: "nope" })).toEqual({ approvals: [], inputs: [] });
    expect(pendingFromThread({ pending: { approvals: "x" } })).toEqual({
      approvals: [],
      inputs: [],
    });
  });

  test("counts both kinds", () => {
    expect(pendingCount(pending)).toBe(2);
  });
});

describe("newRequestIds", () => {
  test("everything is new on the first read", () => {
    expect(newRequestIds(undefined, pending)).toEqual(["a1", "q1"]);
  });

  test("only ids the previous read lacked are new", () => {
    const next: PendingRequests = {
      approvals: [
        ...pending.approvals,
        { requestId: "a2", tool: "Write", input: {}, summary: "Write x" },
      ],
      inputs: [],
    };
    expect(newRequestIds(pending, next)).toEqual(["a2"]);
  });

  test("a resolved request disappearing is not news", () => {
    expect(newRequestIds(pending, { approvals: [], inputs: [] })).toEqual([]);
  });
});

describe("unplacedPending", () => {
  test("turns pending requests into parts when no message shows them yet", () => {
    const parts = unplacedPending([], pending);
    expect(parts).toEqual([
      {
        type: "approval",
        requestId: "a1",
        tool: "Bash",
        input: { command: "ls" },
        summary: "Run ls",
        decision: "pending",
      },
      {
        type: "question",
        requestId: "q1",
        question: "Which layer?",
        options: ["top", "bottom"],
        answer: null,
      },
    ]);
  });

  test("skips requests a message part already carries", () => {
    const parts = unplacedPending([msg("m1", [approvalPart("a1")])], pending);
    expect(parts.map((p) => p.requestId)).toEqual(["q1"]);
  });

  test("a free-text question carries no options key at all", () => {
    const [q] = unplacedPending([], {
      approvals: [],
      inputs: [{ requestId: "q2", question: "Name?" }],
    });
    expect(q).toEqual({ type: "question", requestId: "q2", question: "Name?", answer: null });
    expect(q && "options" in q).toBe(false);
  });
});

describe("resolveInMessages", () => {
  test("marks the approval part decided and records who did it", () => {
    const out = resolveInMessages(
      [msg("m1", [{ type: "text", text: "hi" }, approvalPart("a1")])],
      "a1",
      {
        decision: "approve",
        by: "device",
      },
    );
    expect(out[0]!.parts[1]).toMatchObject({ type: "approval", decision: "approve", by: "device" });
    expect(out[0]!.parts[0]).toEqual({ type: "text", text: "hi" });
  });

  test("fills in a question's answer and leaves other requests alone", () => {
    const q: AnyPart = { type: "question", requestId: "q1", question: "?", answer: null };
    const out = resolveInMessages([msg("m1", [q, approvalPart("a1")])], "q1", { answer: "top" });
    expect(out[0]!.parts[0]).toMatchObject({ answer: "top" });
    expect(out[0]!.parts[1]).toMatchObject({ decision: "pending" });
  });

  test("an unknown id returns an equal list, untouched messages by reference", () => {
    const m = msg("m1", [approvalPart("a1")]);
    const out = resolveInMessages([m], "zzz", { decision: "deny" });
    expect(out[0]).toBe(m);
  });
});

test("withoutRequest drops one id from either list", () => {
  expect(withoutRequest(pending, "a1")).toEqual({ approvals: [], inputs: pending.inputs });
  expect(withoutRequest(pending, "q1")).toEqual({ approvals: pending.approvals, inputs: [] });
});

describe("labels", () => {
  test("strips the MCP server prefix from tool names", () => {
    expect(bareToolName("mcp__fabdesk__render_board")).toBe("render_board");
    expect(bareToolName("fabdesk__route_run")).toBe("route_run");
    expect(bareToolName("Bash")).toBe("Bash");
    expect(bareToolName("project_write_file")).toBe("project_write_file");
  });

  test("decision labels say what happened and where", () => {
    expect(decisionLabel({ decision: "pending" })).toBeNull();
    expect(decisionLabel({ decision: "approve", by: "desktop" })).toBe("✓ approved on desktop");
    expect(decisionLabel({ decision: "deny", by: "device" })).toBe("✗ denied on this phone");
    expect(decisionLabel({ decision: "deny", by: "timeout" })).toBe("✗ denied (timed out)");
    expect(decisionLabel({ decision: "approve" })).toBe("✓ approved");
  });

  test("input preview is one line and bounded", () => {
    expect(inputPreview({ command: "ls\n  -la" })).toBe('{"command":"ls\\n -la"}');
    expect(inputPreview("a  b\n c")).toBe("a b c");
    expect(inputPreview("x".repeat(300), 20)).toHaveLength(20);
    expect(inputPreview(null)).toBe("");
  });

  test("input detail pretty-prints objects and caps huge ones", () => {
    expect(inputDetail({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(inputDetail("plain")).toBe("plain");
    expect(inputDetail("x".repeat(50), 10)).toBe(`${"x".repeat(10)}\n…`);
  });

  test("cleanAnswer trims and rejects empty text", () => {
    expect(cleanAnswer("  top ")).toBe("top");
    expect(cleanAnswer("   ")).toBeNull();
  });
});
