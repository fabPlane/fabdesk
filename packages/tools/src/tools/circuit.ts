/** Circuit toolset: inspect the board KiCad holds and search the footprint libraries. */
import { z } from "zod/v4";
import { defineTool } from "../registry";
import { ok, table } from "./common";

export const circuit_query = defineTool({
  name: "circuit_query",
  toolset: "circuit",
  title: "Query the board",
  description:
    "List board contents from KiCad as a compact table: components, nets, pads, vias, tracks, or unrouted connections. Supports an optional substring filter.",
  inputSchema: {
    select: z.enum(["components", "nets", "pads", "vias", "tracks", "unrouted"]),
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
  title: "Search KiCad libraries",
  description:
    "Search the KiCad symbol or footprint libraries available to the native design server. Returns exact library identifiers for native schematic and PCB operations.",
  inputSchema: {
    query: z.string().min(1).max(200),
    kind: z.enum(["footprint", "symbol"]).default("footprint"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  scope: "global",
  handler: async ({ query, kind, limit }, ctx) => {
    const hits = await (kind === "symbol"
      ? ctx.services.design.searchSymbols(query, limit)
      : ctx.services.design.searchFootprints(query, limit));
    const label = kind === "symbol" ? "Symbols" : "Footprints";
    return ok(
      hits.length
        ? `${label} matching "${query}":\n${table(hits, ["libId", "description"])}`
        : `No ${kind} libraries match "${query}".`,
      { query, kind, hits },
    );
  },
});

export const circuit_describe_part = defineTool({
  name: "circuit_describe_part",
  toolset: "circuit",
  title: "Describe a KiCad part",
  description:
    "Return details for one exact KiCad symbol or footprint. Symbols include pin numbers, names and electrical types; footprints include pad numbers, anchor-relative positions and sizes in millimetres.",
  inputSchema: {
    kind: z.enum(["footprint", "symbol"]),
    libId: z
      .string()
      .min(3)
      .max(300)
      .describe("Exact Library:Name returned by circuit_search_parts"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  scope: "global",
  handler: async ({ kind, libId }, ctx) => {
    const part = await ctx.services.design.describePart(kind, libId);
    const rows = kind === "symbol" ? (part.pins ?? []) : (part.pads ?? []);
    const facts =
      kind === "footprint"
        ? `\nPackage: ${JSON.stringify(part.package ?? { status: "unsupported" })}\nFabrication: ${JSON.stringify(part.fabrication ?? { status: "unsupported" })}`
        : `\nRoles: ${JSON.stringify(part.roleSuitability ?? [])}`;
    return ok(
      `${kind} ${libId}: ${part.description || "(no description)"}${facts}\n${table(rows)}`,
      part,
    );
  },
});

export const circuit_check_part_compatibility = defineTool({
  name: "circuit_check_part_compatibility",
  toolset: "circuit",
  title: "Check symbol and footprint compatibility",
  description:
    "Read-only pre-placement check for one exact KiCad symbol/footprint pair. Reports pin-to-pad mappings, mechanical/fabrication facts, and optional role suitability without modifying a project.",
  inputSchema: {
    symbolLibId: z.string().min(3).max(300).describe("Exact symbol Library:Name"),
    footprintLibId: z.string().min(3).max(300).describe("Exact footprint Library:Name"),
    role: z.enum(["power-only-usb-c"]).optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  scope: "global",
  handler: async ({ symbolLibId, footprintLibId, role }, ctx) => {
    const result = await ctx.services.design.checkPartCompatibility(
      symbolLibId,
      footprintLibId,
      role,
    );
    const state = result.compatible ? "compatible" : "incompatible";
    return ok(
      `${symbolLibId} + ${footprintLibId}: ${state}\nMatched pins/pads: ${result.pinPad.matched.join(", ") || "none"}` +
        `${result.issues.length ? `\nIssues:\n- ${result.issues.join("\n- ")}` : ""}` +
        `${result.warnings.length ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : ""}`,
      result,
    );
  },
});

export const circuitTools = [
  circuit_query,
  circuit_search_parts,
  circuit_describe_part,
  circuit_check_part_compatibility,
];
