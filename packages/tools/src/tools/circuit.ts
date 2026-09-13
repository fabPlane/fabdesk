/** Circuit toolset: inspect the board KiCad holds and search the footprint libraries. */
import { z } from "zod/v4";
import { defineTool } from "../registry";
import { ok, table } from "./common";

export const circuit_query = defineTool({
  name: "circuit_query",
  toolset: "circuit",
  title: "Query the board",
  description:
    "List what the board holds, straight from KiCad, as a compact table: components (ref, value, footprint, position), nets (name, pad count), pads (component, number, net, position, size), vias (position, net; a blank's free vias have an empty net), tracks (routed tracks/arcs/vias per net), unrouted (the airlines still open) or outline (the Edge.Cuts bounding box in mm — read it before circuit_place: the outline's corner is not at 0,0). Optional substring filter on names. Requires circuit_build.",
  inputSchema: {
    select: z.enum(["components", "nets", "pads", "vias", "tracks", "unrouted", "outline"]),
    filter: z
      .string()
      .optional()
      .describe("Case-insensitive substring matched against refs/nets/footprints"),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ select, filter, limit }, ctx) => {
    const project = ctx.requireProject();
    const rows = await ctx.services.design.query(project.dir, select, filter);
    const shown = rows.slice(0, limit);
    return ok(
      `${select}: ${rows.length} rows${rows.length > limit ? ` (showing ${limit})` : ""}\n${table(shown)}`,
      { select, total: rows.length, rows: shown },
    );
  },
});

export const circuit_search_parts = defineTool({
  name: "circuit_search_parts",
  toolset: "circuit",
  title: "Search footprint libraries",
  description:
    "Search the KiCad footprint libraries the design server can see (e.g. 'R_0402', 'SOT-23', 'USB_C', 'LQFP-48') and return library ids to use as `footprint` in circuit.netlist.json, e.g. `Resistor_SMD:R_0402_1005Metric`.",
  inputSchema: {
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  scope: "global",
  handler: async ({ query, limit }, ctx) => {
    const hits = await ctx.services.design.searchFootprints(query, limit);
    return ok(
      hits.length
        ? `Footprints matching "${query}":\n${table(hits, ["libId", "description"])}`
        : `No footprints match "${query}".`,
      { query, hits },
    );
  },
});

export const circuitTools = [circuit_query, circuit_search_parts];
