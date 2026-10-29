import { defineTool } from "../registry";
import { readProjectBom } from "../project-bom";
import { ok } from "./common";

export const bom_read = defineTool({
  name: "bom_read", toolset: "project", title: "Read project BOM",
  description: "Read a captured project BOM from each declared board source’s native schematic and explicit physical instances, plus project hardware. Missing sources and netlist-only coverage stay explicit. Does not alter native sources or claim electrical parity.",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  longRunning: true,
  handler: async (_args, ctx) => { const snapshot = await readProjectBom(ctx); return ok(`${snapshot.lines.length} BOM lines. ${snapshot.complete ? "Native schematic coverage complete" : "Coverage needs review"}; electrical checks remain separate.`, snapshot); },
});
