/**
 * Off-board parts: motors, displays, standoffs, screws and similar hardware that belong in the
 * project BOM but are not compiled onto the PCB. Writes `project.parts.json`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  OFFBOARD_KIND_LABELS,
  OffboardKind,
  findOffboardCatalogPart,
  nextOffboardRef,
  searchOffboardCatalog,
  type ProjectPartLine,
} from "@fabdesk/protocol";
import { PROJECT_FILES } from "../fs";
import { ToolError, defineTool } from "../registry";
import { readProjectBom } from "../project-bom";
import { loadProjectParts, ok, saveProjectParts, table } from "./common";

const KindArg = OffboardKind.describe(
  `Off-board category: ${OFFBOARD_KINDS_HELP()}. Electrical PCB parts stay in the netlist / schematic.`,
);

function OFFBOARD_KINDS_HELP(): string {
  return Object.entries(OFFBOARD_KIND_LABELS)
    .map(([id, label]) => `${id} (${label})`)
    .join(", ");
}

function newLineId(): string {
  return `line_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function partsTable(parts: readonly ProjectPartLine[]): string {
  return table(
    parts.map((p) => ({
      id: p.id,
      ref: p.ref,
      kind: p.kind,
      qty: p.qty,
      name: p.name,
      mpn: p.mpn ?? "",
      catalog: p.catalogId ?? "",
    })),
    ["id", "ref", "kind", "qty", "name", "mpn", "catalog"],
  );
}

export const parts_search = defineTool({
  name: "parts_search",
  toolset: "project",
  scope: "global",
  title: "Search the off-board parts library",
  description:
    "Search fabPlane's off-board parts library (motors, displays, standoffs, screws and similar hardware that is not placed on the PCB). Returns catalog ids for parts_add. Empty query lists the library (optionally filtered by kind).",
  inputSchema: {
    query: z.string().max(200).default("").describe("Substring matched against name, kind, MPN, aliases"),
    kind: KindArg.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ query, kind, limit }) => {
    const hits = searchOffboardCatalog(query, { ...(kind ? { kind } : {}), limit });
    const label = query.trim() ? `matching "${query.trim()}"` : kind ? `in kind ${kind}` : "in the library";
    return ok(
      hits.length
        ? `Off-board parts ${label}:\n${table(
            hits.map((h) => ({
              id: h.id,
              kind: h.kind,
              name: h.name,
              mpn: h.mpn ?? "",
              description: h.description,
            })),
            ["id", "kind", "name", "mpn", "description"],
          )}`
        : `No off-board parts ${label}.`,
      { query, kind: kind ?? null, hits },
    );
  },
});

export const parts_add = defineTool({
  name: "parts_add",
  toolset: "project",
  title: "Add an off-board part",
  description:
    `Add a motor, display, standoff, screw or other off-board / mechanical part to the project (${PROJECT_FILES.projectParts}). Pass catalogId from parts_search, or name + kind for a custom line. These parts appear on the project BOM and shopping-list sync; they are not placed on the PCB.`,
  inputSchema: {
    catalogId: z.string().min(1).optional().describe("Id from parts_search, e.g. nema-17-stepper"),
    name: z.string().min(1).max(200).optional().describe("Required when catalogId is omitted"),
    kind: KindArg.optional().describe("Required when catalogId is omitted"),
    qty: z.number().int().positive().default(1),
    ref: z.string().min(1).max(40).optional().describe("Designator, e.g. M1, DS1. Assigned when omitted."),
    mpn: z.string().max(200).optional(),
    manufacturer: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async ({ catalogId, name, kind, qty, ref, mpn, manufacturer, notes }, ctx) => {
    const project = ctx.requireProject();
    const catalog = catalogId ? findOffboardCatalogPart(catalogId) : undefined;
    if (catalogId && !catalog) throw new ToolError(`unknown catalog id "${catalogId}"; use parts_search`, "not_found");
    const resolvedKind = kind ?? catalog?.kind;
    const resolvedName = name ?? catalog?.name;
    if (!resolvedKind || !resolvedName) {
      throw new ToolError("pass catalogId from parts_search, or both name and kind", "invalid_args");
    }
    const file = await loadProjectParts(project);
    if (ref && file.parts.some((p) => p.ref === ref)) {
      throw new ToolError(`ref ${ref} is already used on this project`, "invalid_args");
    }
    const line: ProjectPartLine = {
      id: newLineId(),
      ref: ref ?? nextOffboardRef(resolvedKind, file.parts.map((p) => p.ref)),
      name: resolvedName,
      kind: resolvedKind,
      qty,
      ...(catalogId ? { catalogId } : {}),
      ...(mpn ?? catalog?.mpn ? { mpn: mpn ?? catalog?.mpn } : {}),
      ...(manufacturer ?? catalog?.manufacturer ? { manufacturer: manufacturer ?? catalog?.manufacturer } : {}),
      ...(notes ? { notes } : {}),
    };
    const next = { schema: 1 as const, parts: [...file.parts, line] };
    await saveProjectParts(project, next);
    return ok(
      `Added ${line.qty} × ${line.name} as ${line.ref} (${line.kind}) to ${PROJECT_FILES.projectParts}.`,
      { part: line, parts: next.parts },
    );
  },
});

export const parts_list = defineTool({
  name: "parts_list",
  toolset: "project",
  title: "List the project BOM",
  description:
    `Show the captured project BOM with explicit native-source coverage and physical instance quantities. Use scope=offboard for ${PROJECT_FILES.projectParts} alone.`,
  inputSchema: {
    scope: z.enum(["bom", "offboard"]).default("bom").describe("bom = electrical + off-board; offboard = project.parts.json only"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ scope }, ctx) => {
    const project = ctx.requireProject();
    const file = await loadProjectParts(project);
    if (scope === "offboard") {
      return ok(
        file.parts.length
          ? `Off-board parts (${file.parts.length}):\n${partsTable(file.parts)}`
          : `No off-board parts in ${PROJECT_FILES.projectParts}. Add motors, displays or hardware with parts_add.`,
        { parts: file.parts },
      );
    }
    const snapshot = await readProjectBom(ctx), bom = snapshot.lines;
    return ok(
      bom.length
        ? `Project BOM (${bom.length} lines; ${snapshot.complete ? "native source coverage complete" : "partial source coverage — review coverage"}):\n${table(
            bom.map((l) => ({
              kind: l.kind,
              source: l.source,
              refs: l.refs.join(" "),
              qty: l.qty,
              name: l.name,
              mpn: l.mpn ?? "",
            })),
            ["kind", "source", "refs", "qty", "name", "mpn"],
          )}`
        : "Project BOM is empty. Write the electrical netlist and/or add off-board parts with parts_add.",
      { bom, parts: file.parts, pcbLines: bom.filter((l) => l.source === "pcb").length, offboardLines: file.parts.length, coverage: snapshot.coverage, complete: snapshot.complete, revision: snapshot.revision },
    );
  },
});

export const parts_remove = defineTool({
  name: "parts_remove",
  toolset: "project",
  title: "Remove an off-board part",
  description: `Delete one off-board line from ${PROJECT_FILES.projectParts} by line id or ref (from parts_list).`,
  inputSchema: {
    id: z.string().min(1).optional().describe("Line id from parts_list"),
    ref: z.string().min(1).optional().describe("Designator, e.g. M1"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async ({ id, ref }, ctx) => {
    if (!id && !ref) throw new ToolError("pass id or ref", "invalid_args");
    const project = ctx.requireProject();
    const file = await loadProjectParts(project);
    const hit = file.parts.find((p) => (id && p.id === id) || (ref && p.ref === ref));
    if (!hit) throw new ToolError(`off-board part not found${id ? ` id=${id}` : ""}${ref ? ` ref=${ref}` : ""}`, "not_found");
    const next = { schema: 1 as const, parts: file.parts.filter((p) => p.id !== hit.id) };
    await saveProjectParts(project, next);
    return ok(`Removed ${hit.ref} (${hit.name}) from ${PROJECT_FILES.projectParts}.`, { removed: hit, parts: next.parts });
  },
});

export const partsTools = [parts_search, parts_add, parts_list, parts_remove];
