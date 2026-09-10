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
  lines.push(
    "Tools are namespaced `mcp__" +
      server +
      "__<name>` in Claude Code. Only the **core** toolset is loaded at start; call `load_toolset {toolset}` to enable the others (the tool list refreshes).",
  );
  lines.push("");
  lines.push(
    '`pcb_environment` describes the exact bundled KiCad CLI, FabPCB bridge, project files, UI availability, and supported working lanes. Use whichever combination of MCP tools, shell commands, bundled `kicad-cli`, direct-file scripts, and the app UI best fits the task. `circuit_build` is a convenience workflow, not a mandatory entry point. Python/scripts are useful for independent file, geometry, and report analysis; if a script connects to KiCad IPC, state that explicitly and do not count it as an independent verification path.',
  );
  lines.push("");
  lines.push('Preserve electrical intent during placement/routing recovery. Never move or delete canonical `board.kicad_*` files while the bridge is active, never use an empty design as a reset, and never add/split/rename circuitry only to help a router. After changed builds, spot-check connector and passive pad nets. Stop and preserve evidence after three failed builds or route jobs unless the user explicitly requests extended diagnosis.');
  lines.push("");
  lines.push('Before claiming release readiness or exporting manufacturing files, run fresh `verify_drc {schematicParity:true}`, `verify_erc`, and `verify_gate {requireErc:true}` against the current project files. Produce both schematic and PCB SVGs when visual evidence is required; `render_board` creates PNG board images only.');
  lines.push("");
  for (const ts of TOOLSETS) {
    const tools = registry.byToolset(ts);
    if (tools.length === 0) continue;
    lines.push(
      `### ${ts} — ${TOOLSET_BLURB[ts] ?? ""}${ts === "core" ? "" : ` (\`load_toolset {"toolset":"${ts}"}\`)`}`,
    );
    lines.push("");
    lines.push("| tool | arguments | what it does |");
    lines.push("| --- | --- | --- |");
    for (const t of tools)
      lines.push(
        `| \`${t.name}\` | ${argsSummary(registry, t)} | ${firstSentence(t.description)}${t.longRunning ? " (long-running)" : ""} |`,
      );
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
      const type =
        typeof v["type"] === "string"
          ? v["type"]
          : Array.isArray(v["enum"])
            ? (v["enum"] as unknown[]).join("\\|")
            : "any";
      return `${k}${required.has(k) ? "" : "?"}: ${type}`;
    });
  return parts.length ? `\`${parts.join(", ")}\`` : "—";
}
