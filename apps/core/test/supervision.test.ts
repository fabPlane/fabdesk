import { describe, expect, test } from "bun:test";
import { createRegistry } from "@fabdesk/tools";
import {
  classifyToolCall,
  parseAskUserQuestion,
  splitMcpName,
  summarizeToolCall,
} from "../src/supervision";

const registry = createRegistry();
const annotations = (tool: string, server: string | null) =>
  server === null || server === "fabdesk" ? registry.get(tool)?.annotations : undefined;
const needs = (name: string, input: unknown = {}) =>
  classifyToolCall(name, input, annotations).needsApproval;

describe("classifyToolCall", () => {
  test("agent-native shells and file edits always pause", () => {
    for (const t of [
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "shell",
      "apply_patch",
      "command_execution",
      "file_change",
    ]) {
      expect({ t, needs: needs(t) }).toEqual({ t, needs: true });
    }
  });

  test("reads never pause", () => {
    for (const t of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task"])
      expect({ t, needs: needs(t) }).toEqual({ t, needs: false });
    for (const t of [
      "project_status",
      "project_read_file",
      "render_board",
      "route_status",
      "circuit_read_errors",
    ]) {
      expect({ t, needs: needs(`mcp__fabdesk__${t}`) }).toEqual({ t, needs: false });
    }
  });

  test("idempotent file writes, exports and renders run unattended", () => {
    const fine = [
      "project_write_file",
      ...registry
        .list()
        .filter((d) => /^(export|render)_/.test(d.name))
        .map((d) => d.name),
    ];
    expect(fine.length).toBeGreaterThan(4);
    for (const t of fine)
      expect({ t, needs: needs(`mcp__fabdesk__${t}`) }).toEqual({ t, needs: false });
  });

  test("non-idempotent fabdesk tools and unknown servers pause", () => {
    for (const t of [
      "app_click", "app_type", "app_send_message", "app_eval",
      "circuit_build", "route_run", "app_screenshot", "app_wait_for",
    ])
      expect({ t, needs: needs(`mcp__fabdesk__${t}`) }).toEqual({ t, needs: true });
    expect(needs("mcp__github__create_issue")).toBe(true);
    expect(needs("mcp__fabdesk__no_such_tool")).toBe(true);
    expect(needs("SomeFutureTool")).toBe(true);
  });

  test("every registered fabdesk tool classifies by its annotations, never by name", () => {
    for (const def of registry.list()) {
      const expected = !(
        def.annotations.readOnlyHint === true || def.annotations.idempotentHint === true
      );
      expect({ tool: def.name, needs: needs(`mcp__fabdesk__${def.name}`) }).toEqual({
        tool: def.name,
        needs: expected,
      });
    }
  });
});

describe("summaries", () => {
  test("one line, the interesting argument first, capped", () => {
    expect(summarizeToolCall("Bash", { command: "rm -rf build\n&& echo   done" })).toBe(
      "Bash: rm -rf build && echo done",
    );
    expect(
      summarizeToolCall("Write", { file_path: "/p/src/main.ts", content: "x".repeat(500) }),
    ).toBe("Write /p/src/main.ts");
    expect(summarizeToolCall("mcp__fabdesk__app_click", { selector: "#send" })).toBe(
      'app_click {"selector":"#send"}',
    );
    expect(summarizeToolCall("command_execution", { command: "/bin/zsh -lc 'ls'" })).toBe(
      "command_execution: /bin/zsh -lc 'ls'",
    );
    expect(summarizeToolCall("file_change", { changes: [{}, {}] })).toBe("file_change 2 file(s)");
    expect(summarizeToolCall("Bash", { command: "x".repeat(300) })).toHaveLength(140);
    expect(summarizeToolCall("Bash", {})).toBe("Bash");
  });

  test("splitMcpName", () => {
    expect(splitMcpName("mcp__fabdesk__route_run")).toEqual({
      server: "fabdesk",
      tool: "route_run",
    });
    expect(splitMcpName("mcp__my-server__do__thing")).toEqual({
      server: "my-server",
      tool: "do__thing",
    });
    expect(splitMcpName("Bash")).toBeNull();
    expect(splitMcpName("mcp__x__")).toBeNull();
  });
});

describe("parseAskUserQuestion", () => {
  test("keeps question text and option labels, drops malformed entries", () => {
    expect(
      parseAskUserQuestion({
        questions: [
          {
            question: "Which regulator?",
            header: "Power",
            options: [{ label: "LDO", description: "quiet" }, { label: "Buck" }],
            multiSelect: false,
          },
          { question: "Free text?" },
          { nope: true },
        ],
      }),
    ).toEqual([
      { question: "Which regulator?", options: [{ label: "LDO" }, { label: "Buck" }] },
      { question: "Free text?" },
    ]);
    expect(parseAskUserQuestion({ questions: [] })).toBeNull();
    expect(parseAskUserQuestion("x")).toBeNull();
  });
});
