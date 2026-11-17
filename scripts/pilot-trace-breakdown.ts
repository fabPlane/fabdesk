/** Read immutable pilot traces; write a separate analysis, never rewrite original metrics/scores. */
import { readFile, writeFile } from "node:fs/promises";
const categories: Array<[string, RegExp]> = [["discovery", /capability|load_toolset|circuit_source|tool.*describe/], ["libraries", /search_parts|describe_part|library|compatibility/], ["routing", /route|routing/], ["verification", /verify|design_inspect|board_check|board_review/], ["rendering", /render|screenshot|view_image/], ["packaging", /export|release|bom/], ["authoring", /circuit_build|schematic|pcb_|board_edit/]];
export function traceBreakdown(trace: string) {
  const uses = new Map<string, { tool: string; input: unknown; start: number; category: string; repeated: boolean }>();
  const signatures = new Set<string>(), rows: Array<{ id: string; tool: string; category: string; seconds: number | null; failed: boolean; repeatedInput: boolean }> = [];
  for (const line of trace.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line), body = event.body ?? {}, time = Number(event.timeUnixNano) / 1e9;
    if (event.type === "agent.tool_use") {
      let tool = String(body.name ?? "unknown").replace(/^mcp__.+?__/, "");
      if (tool === "capability_call") tool = String(body.input?.name ?? tool);
      const signature = JSON.stringify([tool, body.input]);
      uses.set(body.id, { tool, input: body.input, start: time, category: categories.find(([,pattern]) => pattern.test(tool))?.[0] ?? "other", repeated: signatures.has(signature) });
      signatures.add(signature);
    } else if (event.type === "agent.tool_result") {
      const call = uses.get(body.id); if (!call) continue;
      const failed = body.isError === true || body.output?.isError === true || typeof body.output?.exit_code === "number" && body.output.exit_code !== 0;
      rows.push({ id: body.id, tool: call.tool, category: call.category, seconds: Number.isFinite(time) && Number.isFinite(call.start) && time >= call.start ? time - call.start : null, failed, repeatedInput: call.repeated });
    }
  }
  const totals: Record<string, { calls: number; failed: number; repeatedInput: number; observedCallSeconds: number }> = {};
  for (const row of rows) { const group = totals[row.category] ??= { calls: 0, failed: 0, repeatedInput: 0, observedCallSeconds: 0 }; group.calls++; group.failed += Number(row.failed); group.repeatedInput += Number(row.repeatedInput); group.observedCallSeconds += row.seconds ?? 0; }
  return { totals, rows, limits: "Observed call-to-result wall time may overlap. Repeated identical requests are potential reuse/retry candidates, not proven redundant work: inputs may have changed between calls. Success does not establish productive engineering work. No speed or general workflow advantage inferred." };
}
if (import.meta.main) {
  const [input, output] = process.argv.slice(2); if (!input || !output) throw Error("usage: bun scripts/pilot-trace-breakdown.ts scored-trace.jsonl NEW-analysis.json");
  await writeFile(output, JSON.stringify(traceBreakdown(await readFile(input,"utf8")),null,2)+"\n", { flag: "wx" });
}
