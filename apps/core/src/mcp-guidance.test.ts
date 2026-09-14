import { expect, test } from "bun:test";
import { INSTRUCTIONS } from "./mcp-sessions";

test("MCP session instructions identify scope without prescribing a workflow", () => {
  expect(INSTRUCTIONS).toBe("Project-scoped tools use the selected project unless `project` is supplied.");
  expect(INSTRUCTIONS).not.toMatch(/first|then|next|prefer|retry|repeat|workflow|required|must|should|stop/i);
});
