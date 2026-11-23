/** Shared matching for MCP discovery and the shell registry. */
const ALIASES: Record<string, string> = { render_3d: "render_glb", export_pdf: "export_schematic_pdf" };
export function capabilityScore(query: string, tool: { name: string; title: string; description: string; toolset: string }): number {
  const normalized = query.trim().toLowerCase();
  const exact = ALIASES[normalized] ?? normalized;
  if (exact === tool.name.toLowerCase()) return 10000;
  // An exact-looking tool name must not yield unrelated substring matches.
  if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(normalized)) return 0;
  const terms = normalized.split(/[\s_-]+/).filter(Boolean);
  const name = tool.name.toLowerCase();
  const rest = `${tool.title} ${tool.description} ${tool.toolset}`.toLowerCase();
  return terms.reduce((score, term) => score + (name.includes(term) ? 10 : rest.includes(term) ? 1 : 0), 0);
}
