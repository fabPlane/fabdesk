/** Circuit toolset: inspect circuit.json, run tscircuit checks, search parts. */
import { z } from "zod/v4";
import { defineTool, ToolError } from "../registry";
import { loadCircuitJson, ok, table, writeReport } from "./common";

export const circuit_query = defineTool({
  name: "circuit_query",
  toolset: "circuit",
  title: "Query circuit elements",
  description:
    "List elements of the built circuit as a compact table: components (name, ftype, footprint, value), nets (name, member ports), ports (component, pin, net), traces (routed pcb traces) or errors. Optional substring filter on name/type. Reads circuit.routed.json when newer than circuit.json.",
  inputSchema: {
    select: z.enum(["components", "nets", "ports", "traces", "errors"]),
    filter: z.string().optional().describe("Case-insensitive substring matched against names/types"),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ select, filter, limit }, ctx) => {
    const project = ctx.requireProject();
    const { circuitJson, source } = await loadCircuitJson(project);
    const rows = ctx.services.tscircuit.queryCircuit(circuitJson, select, filter) as Array<Record<string, unknown>>;
    const shown = rows.slice(0, limit);
    return ok(`${select} from ${source}: ${rows.length} rows${rows.length > limit ? ` (showing ${limit})` : ""}\n${table(shown)}`, { select, source, total: rows.length, rows: shown });
  },
});

export const circuit_checks = defineTool({
  name: "circuit_checks",
  toolset: "circuit",
  title: "Run tscircuit checks",
  description:
    "Run tscircuit's design checks (@tscircuit/checks runAllChecks: trace overlaps, pin/pad mismatches, nets with a single port, etc.) on the built circuit and write reports/checks.json. Cheaper than KiCad DRC; run it right after a successful build.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const { circuitJson, source } = await loadCircuitJson(project);
    const issues = (await ctx.services.tscircuit.runChecks(circuitJson)).errors as Array<Record<string, unknown>>;
    await writeReport(project, "checks", { at: new Date().toISOString(), source, issues });
    const text = issues.length
      ? `${issues.length} check issue(s) in ${source}:\n${table(issues.slice(0, 100), ["type", "message"])}`
      : `No check issues in ${source}.`;
    return { text, json: { source, count: issues.length, issues }, isError: issues.length > 0 };
  },
});

const REGISTRY_API = "https://registry-api.tscircuit.com";

export const circuit_search_parts = defineTool({
  name: "circuit_search_parts",
  toolset: "circuit",
  title: "Search tscircuit registry",
  description:
    "Search the public tscircuit package registry (registry-api.tscircuit.com) for reusable components and boards by keyword (e.g. 'usb-c', 'esp32', 'ldo 3.3v'). Returns package names importable in circuit.tsx as `import X from \"@tsci/<owner>.<name>\"`, descriptions and stars. Needs network access.",
  inputSchema: {
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  scope: "global",
  handler: async ({ query, limit }, ctx) => {
    const f = ctx.services.fetch ?? fetch;
    const res = await f(`${REGISTRY_API}/packages/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: ctx.signal,
    }).catch((e: unknown) => {
      throw new ToolError(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`, "unavailable");
    });
    if (!res.ok) throw new ToolError(`registry search failed: HTTP ${res.status}`, "unavailable");
    const body = (await res.json()) as { packages?: Array<Record<string, unknown>> };
    const packages = (body.packages ?? []).slice(0, limit).map((pk) => {
      const name = String(pk["name"] ?? "");
      return {
        name,
        import: name.includes("/") ? `@tsci/${name.replace("/", ".")}` : name,
        description: String(pk["ai_description"] ?? pk["description"] ?? ""),
        version: pk["latest_version"] ?? null,
        stars: pk["star_count"] ?? 0,
        license: pk["license"] ?? null,
        pcbPreview: pk["latest_pcb_preview_image_url"] ?? null,
      };
    });
    return ok(packages.length ? `Registry results for "${query}":\n${table(packages, ["name", "import", "version", "stars", "description"])}` : `No packages match "${query}".`, { query, packages });
  },
});

export const circuitTools = [circuit_query, circuit_checks, circuit_search_parts];
