import type { Message } from "@fabdesk/protocol";
const labels: Record<string, string> = {
  circuit_build: "Building the native design", circuit_search_parts: "Resolving components", circuit_describe_part: "Resolving components", circuit_library: "Resolving project libraries", circuit_source: "Checking the design source",
  schematic_edit: "Editing the schematic", pcb_edit: "Editing the board", pcb_place: "Placing components", pcb_footprint: "Updating a footprint", route_run: "Routing the board", route_apply: "Saving routed copper", verify_drc: "Checking the saved board", verify_erc: "Checking the schematic", verify_gate: "Checking handoff readiness", design_inspect: "Inspecting the saved design",
  render_publish: "Publishing current views and checks", render_view: "Rendering the board", render_pcb_svg: "Rendering the board", render_schematic_svg: "Rendering the schematic", render_glb: "Preparing the 3D view", export_zip: "Packaging the handoff", export_bom: "Preparing the parts list", export_gerbers: "Exporting production layers", export_drill: "Exporting drill files",
  board_check: "Checking workflow requirements", board_route: "Routing the board", board_edit: "Editing the board", board_review: "Reviewing the board", board_release: "Preparing release evidence", board_silk: "Reviewing silkscreen",
};
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** Derived from persisted tool history, so reconnect/navigation use the same evidence. No inferred ETA or design pass. */
export function summarizeRunWork(messages: Message[], startedAt: number) {
  const parts = messages.filter(m => m.role === "assistant" && Date.parse(m.createdAt) >= startedAt).flatMap(m => m.parts);
  const results = new Map(parts.filter(p => p.type === "tool_result").map(p => [p.id, p]));
  const uses = parts.filter(p => p.type === "tool_use");
  const logical = (use: typeof uses[number]) => {
    const name = use.name.replace(/^mcp__.+?__/, "").replace(/^functions\./, "");
    return name === "capability_call" && typeof record(use.input)?.name === "string" ? String(record(use.input)!.name) : name;
  };
  const latest = uses.at(-1); if (!latest) return null;
  const name = logical(latest), result = results.get(latest.id), output = record(result?.output);
  const failed = result?.isError === true || output?.isError === true || output?.ok === false;
  let attempts = 0;
  for (let i = uses.length - 1; i >= 0 && logical(uses[i]!) === name; i--) attempts++;
  const completed = [...uses].reverse().find(use => results.has(use.id));
  const last = completed && results.get(completed.id);
  const lastFailed = last?.isError === true || record(last?.output)?.isError === true || record(last?.output)?.ok === false;
  return {
    stage: labels[name] ?? "Working on the next recorded step",
    state: failed ? "blocked" as const : result ? "completed" as const : "running" as const,
    attempts,
    completed: completed ? `${labels[logical(completed)] ?? "Latest operation"}: ${lastFailed ? "reported a concern" : "finished; result recorded"}` : null,
    next: failed ? "Review the recorded error in tool details; completed work remains available. Retry after resolving the cause." : result ? "Waiting for the next recorded action." : "Waiting for this operation to return.",
  };
}
