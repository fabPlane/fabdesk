import { expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { summarizeRunWork } from "./run-work-summary";
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
