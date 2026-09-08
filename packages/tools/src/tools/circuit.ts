/** Circuit toolset: inspect the board KiCad holds and search the footprint libraries. */
import { z } from "zod/v4";
import { defineTool } from "../registry";
import { ok, table } from "./common";

export const circuit_query = defineTool({
  name: "circuit_query",
  toolset: "circuit",
  title: "Query the board",
  description:
    "List what the board holds, straight from KiCad, as a compact table: components (ref, value, footprint, position), nets (name, pad count), pads (component, number, net, position, size), vias (position, net; a blank's free vias have an empty net), tracks (routed tracks/arcs/vias per net) or unrouted (the airlines still open). Optional substring filter on names. Requires circuit_build.",
  inputSchema: {
    select: z.enum(["components", "nets", "pads", "vias", "tracks", "unrouted"]),
    filter: z.string().optional().describe("Case-insensitive substring matched against refs/nets/footprints"),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ select, filter, limit }, ctx) => {
    const project = ctx.requireProject();
    const rows = await ctx.services.design.query(project.dir, select, filter);
    const shown = rows.slice(0, limit);
    return ok(`${select}: ${rows.length} rows${rows.length > limit ? ` (showing ${limit})` : ""}\n${table(shown)}`, { select, total: rows.length, rows: shown });
  },
});

export const circuit_search_parts = defineTool({
  name: "circuit_search_parts",
  toolset: "circuit",
  title: "Search KiCad libraries",
  description:
    "Search the KiCad footprint or symbol libraries the design server can see. Footprint results go in component `footprint`; symbol results split at the colon into `libSource: {lib, part}` so circuit_build can draw the generated schematic.",
  inputSchema: {
    query: z.string().min(1).max(200),
    kind: z.enum(["footprint", "symbol"]).default("footprint"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  scope: "global",
  handler: async ({ query, kind, limit }, ctx) => {
    const hits = await (kind === "symbol" ? ctx.services.design.searchSymbols(query, limit) : ctx.services.design.searchFootprints(query, limit));
    const label = kind === "symbol" ? "Symbols" : "Footprints";
    return ok(hits.length ? `${label} matching "${query}":\n${table(hits, ["libId", "description"])}` : `No ${kind} libraries match "${query}".`, { query, kind, hits });
  },
});

export const circuit_describe_part = defineTool({
  name: "circuit_describe_part",
  toolset: "circuit",
  title: "Describe a KiCad part",
  description:
    "Inspect one exact KiCad symbol or footprint before wiring or placing it. Symbols return pin numbers, names and electrical types; footprints return pad numbers, anchor-relative positions and sizes in millimetres.",
  inputSchema: {
    kind: z.enum(["footprint", "symbol"]),
    libId: z.string().min(3).max(300).describe("Exact Library:Name returned by circuit_search_parts"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  scope: "global",
  handler: async ({ kind, libId }, ctx) => {
    const part = await ctx.services.design.describePart(kind, libId);
    const rows = kind === "symbol" ? part.pins ?? [] : part.pads ?? [];
    return ok(`${kind} ${libId}: ${part.description || "(no description)"}\n${table(rows)}`, part);
  },
});

export const circuitTools = [circuit_query, circuit_search_parts, circuit_describe_part];
