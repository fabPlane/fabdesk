import { expect, test } from "bun:test";
import { INSTRUCTIONS } from "./mcp-sessions";

test("MCP session instructions identify scope without prescribing a workflow", () => {
  expect(INSTRUCTIONS).toBe(
    "fabdesk exposes optional PCB project tools. Project-scoped tools use the selected project unless a project argument is supplied.",
  );
  expect(INSTRUCTIONS).not.toMatch(/first|then|next|prefer|retry|repeat|workflow|required|must|should|stop/i);
});
