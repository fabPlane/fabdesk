/** Circuit toolset: inspect the board KiCad holds and search the footprint libraries. */
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { z } from "zod/v4";
import {
  buildSystemDiagramFromSources,
  formatSystemSummary,
  type DesignSources,
} from "@fabdesk/protocol";
import { defineTool } from "../registry";
import { exists, PROJECT_FILES } from "../fs";
import { loadNetlistOrNull, ok, p, table } from "./common";

export const circuit_query = defineTool({
  name: "circuit_query",
  toolset: "circuit",
  title: "Query the board",
  description:
    "List board contents from KiCad as a compact table: components, nets, pads, vias, tracks, unrouted connections, or the board outline. Supports an optional substring filter.",
  inputSchema: {
    select: z.enum(["components", "nets", "pads", "vias", "tracks", "unrouted", "outline"]),
    filter: z
      .string()
      .optional()
      .describe("Case-insensitive substring matched against refs/nets/footprints"),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
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
    "Search the KiCad symbol or footprint libraries available to the native design server. Returns exact library identifiers, descriptions, and role suitability for native schematic and PCB operations.",
  inputSchema: {
    query: z.string().min(1).max(200),
    kind: z.enum(["footprint", "symbol"]).default("footprint"),
    role: z
      .enum(["power-only-usb-c"])
      .optional()
      .describe("Optional functional role used to rank matching parts"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  scope: "global",
  handler: async ({ query, kind, role, limit }, ctx) => {
    const searchQuery = role ? `${query} power-only USB-C` : query;
    const matches = await (kind === "symbol"
      ? ctx.services.design.searchSymbols(searchQuery, limit)
      : ctx.services.design.searchFootprints(searchQuery, limit));
    // Search is for discovery, so do not echo embedded pin/pad geometry for every candidate.
    // Exact details remain available through circuit_describe_part.
    const hits = matches.map(({ libId, description, part }) => ({
      libId,
      description,
      ...(role
        ? {
            roleSuitable:
              part?.roleSuitability?.find((entry) => entry.role === role)?.suitable ?? false,
          }
        : {}),
    }));
    const label = kind === "symbol" ? "Symbols" : "Footprints";
    return ok(
      hits.length
        ? `${label} matching "${query}":\n${table(hits, ["libId", "description"])}`
        : `No ${kind} libraries match "${query}".`,
      { query, kind, role: role ?? null, hits },
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
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
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
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
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

async function collectDesignFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".fabdesk" || entry.name === "node_modules" || entry.name === "renders" || entry.name === "exports") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.includes(".unrouted.") && (entry.name.endsWith(".kicad_pcb") || entry.name.endsWith(".kicad_sch") || entry.name === PROJECT_FILES.netlistJson)) {
        found.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  await walk(dir);
  return found.sort();
}

export const circuit_system = defineTool({
  name: "circuit_system",
  toolset: "circuit",
  title: "System block diagram",
  description:
    "Group the project's parts into functional blocks and report labelled connections (power rails, buses such as I2C/SPI/UART/USB, and other notable nets). Uses schematic sheets when present, otherwise part type, reference prefix, and net names.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const files = await collectDesignFiles(project.dir);
    const pcbRel = files.find((path) => path === PROJECT_FILES.boardPcb) ?? files.find((path) => path.endsWith(".kicad_pcb"));
    const schRels = files.filter((path) => path.endsWith(".kicad_sch"));
    const pcbText = pcbRel && (await exists(p(project, pcbRel))) ? await readFile(p(project, pcbRel), "utf8") : undefined;
    const schematics = [];
    for (const rel of schRels) {
      if (!(await exists(p(project, rel)))) continue;
      schematics.push({ name: basename(rel, ".kicad_sch"), text: await readFile(p(project, rel), "utf8") });
    }
    const netlist = await loadNetlistOrNull(project);
    const sources: DesignSources = {
      ...(netlist ? { netlist } : {}),
      ...(pcbText ? { pcbText } : {}),
      ...(schematics.length ? { schematics } : {}),
    };
    const diagram = buildSystemDiagramFromSources(sources);
    const summary = formatSystemSummary(diagram);
    return ok(summary, {
      blocks: diagram.blocks.map((block) => ({
        id: block.id,
        name: block.name,
        kind: block.kind,
        source: block.source,
        parts: block.parts.map((part) => part.ref),
        keyParts: block.keyParts.map((part) => ({ ref: part.ref, value: part.value })),
        ...(block.passiveSummary ? { passiveSummary: block.passiveSummary } : {}),
      })),
      edges: diagram.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, labels: edge.labels })),
    });
  },
});

export const circuitTools = [
  circuit_query,
  circuit_search_parts,
  circuit_describe_part,
  circuit_check_part_compatibility,
  circuit_system,
];
