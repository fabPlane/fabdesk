import type { Message } from "@fabdesk/protocol";
const labels: Record<string, string> = {
  circuit_build: "Building the native design", circuit_search_parts: "Resolving components", circuit_describe_part: "Resolving components", circuit_library: "Resolving project libraries", circuit_source: "Checking the design source",
  schematic_edit: "Editing the schematic", pcb_edit: "Editing the board", pcb_place: "Placing components", pcb_footprint: "Updating a footprint", route_run: "Routing the board", route_apply: "Saving routed copper", verify_drc: "Checking the saved board", verify_erc: "Checking the schematic", verify_gate: "Checking handoff readiness", design_inspect: "Inspecting the saved design",
  render_publish: "Publishing current views and checks", render_view: "Rendering the board", render_pcb_svg: "Rendering the board", render_schematic_svg: "Rendering the schematic", render_glb: "Preparing the 3D view", export_zip: "Packaging the handoff", export_bom: "Preparing the parts list", export_gerbers: "Exporting production layers", export_drill: "Exporting drill files",
  board_job: "Checking a running board job", board_engines: "Checking routing engines", route_status: "Checking routing progress", capability_search: "Looking up a tool",
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

export type RunStep = { id: string; label: string; state: "running" | "done" | "failed"; detail?: string };

const resultText = (output: unknown): string => {
  if (typeof output === "string") return output;
  const fields = record(output);
  if (typeof fields?.text === "string") return fields.text;
  const first = Array.isArray(fields?.content) ? record(fields.content[0]) : null;
  return typeof first?.text === "string" ? first.text : "";
};

const SHELL_TOOLS = new Set(["command_execution", "Bash", "bash", "shell", "local_shell", "exec_command"]);

/** The command an agent's shell tool ran, without the `zsh -lc "…"` wrapper, as one short line. */
const shellCommand = (input: unknown): string => {
  const raw = record(input)?.command;
  const text = Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : "";
  const inner = /^\S*(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(text.trim())?.[2] ?? text;
  const first = inner.split("\n").find(part => part.trim())?.trim() ?? "";
  // An inline script's first line is only its opener (`python3 - <<'PY'`); name the script instead.
  const line = first.replace(/\s*-?\s*<<-?\s*['"]?\w+['"]?.*$/, " (inline script)");
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
};

/**
 * The latest tool steps of a run, oldest first, for a "what is the agent doing" list. Like
 * `summarizeRunWork` it reads only persisted tool history; `detail` is the first line the tool
 * returned, shortened, so a failed build shows its reason without opening tool details. A streak
 * of shell commands is one step (count plus the latest command) so file inspection does not push
 * the design steps out of the list.
 */
export function recentRunSteps(messages: Message[], startedAt: number, limit = 6): RunStep[] {
  const parts = messages.filter(m => m.role === "assistant" && Date.parse(m.createdAt) >= startedAt).flatMap(m => m.parts);
  const results = new Map(parts.filter(p => p.type === "tool_result").map(p => [p.id, p]));
  const steps: RunStep[] = [];
  let shell = null as { id: string; count: number; pending: boolean; command: string } | null;
  const flushShell = () => {
    if (!shell) return;
    steps.push({
      id: shell.id,
      label: shell.pending ? "Running a command" : shell.count === 1 ? "Ran a command" : `Ran ${shell.count} commands`,
      state: shell.pending ? "running" : "done",
      ...(shell.command ? { detail: shell.command } : {}),
    });
    shell = null;
  };
  for (const use of parts) {
    if (use.type !== "tool_use") continue;
    const bare = use.name.replace(/^mcp__.+?__/, "").replace(/^functions\./, "");
    const result = results.get(use.id);
    if (SHELL_TOOLS.has(bare)) {
      shell = { id: use.id, count: (shell?.count ?? 0) + 1, pending: !result, command: shellCommand(use.input) };
      continue;
    }
    flushShell();
    const name = bare === "capability_call" && typeof record(use.input)?.name === "string" ? String(record(use.input)!.name) : bare;
    const output = record(result?.output);
    const failed = result?.isError === true || output?.isError === true || output?.ok === false;
    // Skip lines that are only brackets or punctuation (the opening of a JSON reply).
    const line = result ? resultText(result.output).split("\n").find(text => /[\p{L}\p{N}]{2}/u.test(text))?.trim() ?? "" : "";
    steps.push({
      id: use.id,
      label: labels[name] ?? name.replace(/_/g, " "),
      state: !result ? "running" : failed ? "failed" : "done",
      ...(line ? { detail: line.length > 160 ? `${line.slice(0, 159)}…` : line } : {}),
    });
  }
  flushShell();
  return steps.slice(-limit);
}

/** The agent's most recent words in a run, shortened to one line; null before it has said anything. */
export function latestRunNote(messages: Message[], startedAt: number): string | null {
  const texts = messages.filter(m => m.role === "assistant" && Date.parse(m.createdAt) >= startedAt)
    .flatMap(m => m.parts).filter(p => p.type === "text").map(p => p.text.trim()).filter(Boolean);
  const last = texts.at(-1)?.replace(/\s+/g, " ");
  return last ? (last.length > 220 ? `${last.slice(0, 219)}…` : last) : null;
}
