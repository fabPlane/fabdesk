import { NetlistFile } from "@fabdesk/protocol";
import { readFile } from "node:fs/promises";
import { jailPath } from "../fs";
/** Circuit toolset: inspect the board KiCad holds and search the footprint libraries. */
import { z } from "zod/v4";
import { defineTool } from "../registry";
import { ToolError } from "../registry";
import { COMPILER_SOURCE_GUIDE, formatCompilerSourceHelp } from "./compiler-source-guide";
import { ok, table } from "./common";

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
      ? ctx.services.design.searchSymbols(searchQuery, limit, ctx.project?.dir)
      : ctx.services.design.searchFootprints(searchQuery, limit, ctx.project?.dir));
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
    const part = await ctx.services.design.describePart(kind, libId, ctx.project?.dir);
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
      ctx.project?.dir,
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

/** Library management has no existing mutation tool; keep registration in one project-scoped action. */
export const circuit_library = defineTool({
  name: "circuit_library",
  toolset: "circuit",
  title: "Manage a project library",
  description: "Register an existing project-local KiCad library for search, description and native edits. Paths must stay inside the project; saved table URIs use ${KIPRJMOD}.",
  inputSchema: {
    action: z.literal("register"),
    kind: z.enum(["footprint", "symbol"]),
    nickname: z.string().min(1).max(200),
    path: z.string().min(1).describe("Project-relative .pretty directory or .kicad_sym file"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ kind, nickname, path }, ctx) => {
    const project = ctx.requireProject();
    if (!ctx.services.design.registerLibrary) throw new ToolError("project library registration is unavailable", "precondition");
    const result = await ctx.services.design.registerLibrary(project.dir, kind, nickname, path);
    return ok(`Registered ${kind} library ${nickname}: ${result.uri}`, result);
  },
});

export const circuit_source = defineTool({
  name: "circuit_source", toolset: "circuit", title: "Inspect or validate compiler source",
  description: "Read the compiler source schema/example or validate saved source without starting KiCad or modifying files. Validation is structural and checks references/nets; native library compatibility, ERC and DRC remain separate.",
  inputSchema: { action: z.enum(["schema", "validate"]), path: z.string().default("circuit.netlist.json") },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ action, path }, ctx) => {
    if (action === "schema") return ok(formatCompilerSourceHelp(COMPILER_SOURCE_GUIDE) + '\nCheck the saved file with circuit_source {"action":"validate"} before circuit_build.', { schema: z.toJSONSchema(NetlistFile), example: { netlist: { components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric", libSource: { lib: "Device", part: "R" } }], nets: [{ name: "TEST", nodes: [{ ref: "R1", pin: "1" }, { ref: "R1", pin: "2" }] }] }, board: { widthMm: 30, heightMm: 20 } } });
    const project = ctx.requireProject();
    let data: unknown;
    try { data = JSON.parse(await readFile(await jailPath(project.dir, path), "utf8")); }
    catch (error) { throw new ToolError(`Cannot read source ${path}: ${error instanceof Error ? error.message : String(error)}`, "invalid_args"); }
    const parsed = NetlistFile.safeParse(data);
    if (!parsed.success) return { ...ok("Compiler source is invalid.", { valid: false, issues: parsed.error.issues }), isError: true };
    const errors: string[] = [], refs = new Set<string>(), nets = new Set<string>();
    for (const component of parsed.data.netlist.components) { if (refs.has(component.ref)) errors.push(`duplicate component ${component.ref}`); refs.add(component.ref); }
    const pins = new Set<string>();
    for (const net of parsed.data.netlist.nets) {
      if (nets.has(net.name)) errors.push(`duplicate net ${net.name}`); nets.add(net.name);
      for (const node of net.nodes) {
        if (!refs.has(node.ref)) errors.push(`${net.name} references missing component ${node.ref}`);
        const pin = `${node.ref}:${node.pin}`; if (pins.has(pin)) errors.push(`pin ${pin} appears more than once`); pins.add(pin);
      }
    }
    return { ...ok(errors.length ? "Compiler source validation failed." : "Compiler source is structurally valid; library compatibility and native checks remain unverified.", { valid: !errors.length, errors, components: refs.size, nets: nets.size, nativeChecks: "not_run" }), isError: !!errors.length };
  },
});

export const circuitTools = [
  circuit_source,
  circuit_library,
  circuit_query,
  circuit_search_parts,
  circuit_describe_part,
  circuit_check_part_compatibility,
];
