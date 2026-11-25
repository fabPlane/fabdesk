import { expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { latestRunNote, recentRunSteps, summarizeRunWork } from "./run-work-summary";
const message = (parts: Message["parts"], time = "2026-11-17T00:00:01Z") => ({ id: "m", threadId: "t", role: "assistant", createdAt: time, parts } as Message);
test("summaries survive reload, isolate current run and distinguish recorded completion from a clean check", () => {
  const calls = message([{ type: "tool_use", id: "1", name: "capability_call", input: { name: "verify_drc" } }, { type: "tool_result", id: "1", output: { counts: { errors: 4 } } }]);
  const summary = summarizeRunWork(JSON.parse(JSON.stringify([calls])), Date.parse("2026-11-17T00:00:00Z"));
  expect(summary?.stage).toBe("Checking the saved board"); expect(summary?.completed).toContain("finished; result recorded"); expect(JSON.stringify(summary)).not.toContain("passed");
  expect(summarizeRunWork([calls], Date.parse("2026-11-17T00:00:02Z"))).toBeNull();
});
test("repeated failures remain visible with a next action and their history intact", () => {
  const m = message([{ type: "tool_use", id: "1", name: "route_run", input: {} }, { type: "tool_result", id: "1", output: "failed", isError: true }, { type: "tool_use", id: "2", name: "route_run", input: {} }, { type: "tool_result", id: "2", output: "failed", isError: true }]);
  const summary = summarizeRunWork([m], 0); expect(summary?.attempts).toBe(2); expect(summary?.state).toBe("blocked"); expect(summary?.next).toContain("recorded error"); expect(m.parts).toHaveLength(4);
});

test("recent steps name each tool call with its state and the first line it returned", () => {
  const m = message([
    { type: "text", text: "I'll continue from the 69-part draft.\n\nChecking the footprints first." },
    { type: "tool_use", id: "1", name: "mcp__fabdesk__circuit_source", input: {} }, { type: "tool_result", id: "1", output: { text: "Source valid" } },
    { type: "tool_use", id: "2", name: "mcp__fabdesk__circuit_build", input: {} },
    { type: "tool_result", id: "2", output: { content: [{ type: "text", text: "\nBuild FAILED (1 errors):\n- 55 ERC error(s)" }], isError: true } },
    { type: "tool_use", id: "3", name: "custom_step", input: {} },
  ]);
  expect(recentRunSteps([m], 0)).toEqual([
    { id: "1", label: "Checking the design source", state: "done", detail: "Source valid" },
    { id: "2", label: "Building the native design", state: "failed", detail: "Build FAILED (1 errors):" },
    { id: "3", label: "custom step", state: "running" },
  ]);
  expect(recentRunSteps([m], 0, 1).map((step) => step.id)).toEqual(["3"]);
  expect(recentRunSteps([m], Date.parse("2026-11-17T00:00:02Z"))).toEqual([]);
  expect(latestRunNote([m], 0)).toBe("I'll continue from the 69-part draft. Checking the footprints first.");
  expect(latestRunNote([message([])], 0)).toBeNull();
});

test("a streak of shell commands is one step that shows the latest command", () => {
  const m = message([
    { type: "tool_use", id: "1", name: "mcp__fabdesk__circuit_build", input: {} }, { type: "tool_result", id: "1", output: { text: "Build OK" } },
    { type: "tool_use", id: "2", name: "command_execution", input: { command: "/bin/zsh -lc 'ls -a | head -30'" } }, { type: "tool_result", id: "2", output: { aggregated_output: ".", exit_code: 0 } },
    { type: "tool_use", id: "3", name: "command_execution", input: { command: "/bin/zsh -lc \"python3 - <<'PY'\nprint(1)\nPY\"" } }, { type: "tool_result", id: "3", output: { aggregated_output: "1", exit_code: 0 } },
    { type: "tool_use", id: "4", name: "mcp__fabdesk__route_run", input: {} }, { type: "tool_result", id: "4", output: { text: "[\n  {\n\"status\": \"Routed\"" } },
    { type: "tool_use", id: "5", name: "command_execution", input: { command: "/bin/zsh -lc 'cat fabdesk.json'" } },
  ]);
  expect(recentRunSteps([m], 0)).toEqual([
    { id: "1", label: "Building the native design", state: "done", detail: "Build OK" },
    { id: "3", label: "Ran 2 commands", state: "done", detail: "python3 (inline script)" },
    { id: "4", label: "Routing the board", state: "done", detail: "\"status\": \"Routed\"" },
    { id: "5", label: "Running a command", state: "running", detail: "cat fabdesk.json" },
  ]);
});

test("a failed shell command is not shown as done", () => {
  const run = (id: string, output: unknown, isError?: boolean): Message["parts"] => [
    { type: "tool_use", id, name: "command_execution", input: { command: `/bin/zsh -lc 'step ${id}'` } },
    { type: "tool_result", id, output, ...(isError ? { isError } : {}) },
  ];
  const failedLast = message([...run("1", { exit_code: 0 }), ...run("2", { aggregated_output: "boom", exit_code: 2 }, true)]);
  expect(recentRunSteps([failedLast], 0)).toEqual([{ id: "2", label: "Ran 2 commands (1 failed)", state: "failed", detail: "step 2" }]);
  const failedEarlier = message([...run("1", { exit_code: 1 }), ...run("2", { exit_code: 0 })]);
  expect(recentRunSteps([failedEarlier], 0)).toEqual([{ id: "2", label: "Ran 2 commands (1 failed)", state: "done", detail: "step 2" }]);
  expect(recentRunSteps([message(run("1", "failed", true))], 0)).toEqual([{ id: "1", label: "Ran a command", state: "failed", detail: "step 1" }]);
});
