/** AGENTS.md cheat-sheet generated from the registry. */
import { TOOLSETS, type ToolDef, type ToolRegistry } from "../registry";

const TOOLSET_BLURB: Record<string, string> = {
  core: "always available",
  project: "files, sketches, board settings",
  circuit: "query the board, footprint search",
  route: "routing status/cancel/partial reroute",
  kicad: "KiCad conversion and stats",
  verify: "ERC and release gate",
  render: "SVG/GLB renders",
  export: "fabrication outputs",
  sim: "SPICE",
  app: "screenshot and drive the desktop app (dev / FABDESK_AUTOMATION=1)",
};

export function toolsMarkdown(registry: ToolRegistry, opts: { serverName?: string } = {}): string {
  const server = opts.serverName ?? "fabdesk";
  const lines: string[] = [];
  lines.push(`## fabdesk MCP tools (server \`${server}\`)`);
  lines.push("");
  lines.push("Tools are namespaced `mcp__" + server + "__<name>` in Claude Code. Only the **core** toolset is loaded at start; call `load_toolset {toolset}` to enable the others (the tool list refreshes).");
  lines.push("");
  lines.push("Recommended workflow: `project_status` → write `circuit.netlist.json` (`project_write_file`) → `circuit_build` → `circuit_read_errors` (fix, rebuild) → `route_run` → `verify_drc` → `render_board`.");
  lines.push("");
  for (const ts of TOOLSETS) {
    const tools = registry.byToolset(ts);
    if (tools.length === 0) continue;
    lines.push(`### ${ts} — ${TOOLSET_BLURB[ts] ?? ""}${ts === "core" ? "" : ` (\`load_toolset {"toolset":"${ts}"}\`)`}`);
    lines.push("");
    lines.push("| tool | arguments | what it does |");
    lines.push("| --- | --- | --- |");
    for (const t of tools) lines.push(`| \`${t.name}\` | ${argsSummary(registry, t)} | ${firstSentence(t.description)}${t.longRunning ? " (long-running)" : ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function firstSentence(s: string): string {
  const m = s.match(/^(.*?\.)(\s|$)/);
  return (m ? m[1]! : s).replace(/\|/g, "\\|");
}

function argsSummary(registry: ToolRegistry, def: ToolDef): string {
  const schema = registry.jsonSchema(def);
  const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  const parts = Object.entries(props)
    .filter(([k]) => k !== "project")
    .map(([k, v]) => {
      const type = typeof v["type"] === "string" ? v["type"] : Array.isArray(v["enum"]) ? (v["enum"] as unknown[]).join("\\|") : "any";
      return `${k}${required.has(k) ? "" : "?"}: ${type}`;
    });
  return parts.length ? `\`${parts.join(", ")}\`` : "—";
}
