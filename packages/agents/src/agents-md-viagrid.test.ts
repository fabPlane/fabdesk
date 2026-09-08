import { describe, expect, test } from "bun:test";
import { renderAgentsMd } from "./agents-md";

const ctx = { projectName: "vg", toolsMarkdown: "", sketches: [], mcpServerName: "fabdesk" };

describe("AGENTS.md for a prefab blank", () => {
  test("states the Viagrid rules when board.template is viagrid-9055", () => {
    const md = renderAgentsMd({ ...ctx, board: { layers: 2, widthMm: 90, heightMm: 55, template: "viagrid-9055" } });
    expect(md).toContain("## Viagrid 9055 blank");
    expect(md).toContain("Layer changes happen only through the factory vias");
    expect(md).toContain("verify_viagrid");
    expect(md).toContain("describe vias or holes in the netlist");
    expect(md).toContain("board.placements");
    expect(md).toContain("x = blank x + 45");
  });

  test("says nothing about blanks otherwise", () => {
    const md = renderAgentsMd({ ...ctx, board: { layers: 2 } });
    expect(md).not.toContain("Viagrid");
  });
});
