/** Project files library: datasheets and docs next to the board. */
import { z } from "zod/v4";
import { LibraryEntryPatch, LibraryKind } from "@fabdesk/protocol";
import { citeLibrary, listLibrary, patchLibraryEntry, searchLibrary } from "../library";
import { defineTool, ToolError } from "../registry";
import { ok, table } from "./common";

export const project_files_list = defineTool({
  name: "project_files_list",
  toolset: "project",
  title: "List project library files",
  description:
    "List supporting documents in files/ (datasheets, app notes, research, images, source). Includes tags, folders, and component links (linkedRefs / linkedMpns).",
  inputSchema: {
    kind: LibraryKind.optional().describe("Limit to one kind, e.g. datasheet"),
    ref: z.string().min(1).max(80).optional().describe("Only files linked to this component reference"),
    tag: z.string().min(1).max(40).optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ kind, ref, tag }, ctx) => {
    const project = ctx.requireProject();
    const entries = (await listLibrary(project)).filter((entry) => {
      if (kind && entry.kind !== kind) return false;
      if (ref && !entry.linkedRefs.some((item) => item.toLowerCase() === ref.toLowerCase())) return false;
      if (tag && !entry.tags.some((item) => item.toLowerCase() === tag.toLowerCase())) return false;
      return true;
    });
    const rows = entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      path: entry.path,
      tags: entry.tags.join(", "),
      refs: entry.linkedRefs.join(", "),
    }));
    return ok(
      entries.length === 0
        ? "No supporting documents in files/. Users add them from the Files tab."
        : table(rows),
      { entries, file: "files/library.json" },
    );
  },
});

export const project_files_search = defineTool({
  name: "project_files_search",
  toolset: "project",
  title: "Search project library files",
  description:
    "Search files/ by file name, tags, and extracted text (including PDF page text). Hits include title, path, snippet, and a page number when the match is inside a PDF.",
  inputSchema: {
    q: z.string().min(1).max(200).describe("Words to match in names, tags, or file/PDF text"),
    ref: z.string().min(1).max(80).optional().describe("Only files linked to this component reference"),
    limit: z.number().int().min(1).max(50).default(12),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ q, ref, limit }, ctx) => {
    const project = ctx.requireProject();
    const hits = await searchLibrary(project, q, { ...(ref ? { ref } : {}), limit });
    const lines =
      hits.length === 0
        ? "No matching project files."
        : hits
            .map((hit) => {
              const page = hit.page ? ` p.${hit.page}` : "";
              const refs = hit.linkedRefs.length ? ` [${hit.linkedRefs.join(", ")}]` : "";
              return `- ${hit.title}${page}${refs} (${hit.path}): ${hit.snippet}`;
            })
            .join("\n");
    return ok(lines, { hits, query: q });
  },
});

export const project_files_cite = defineTool({
  name: "project_files_cite",
  toolset: "project",
  title: "Cite a project library file",
  description:
    "Read an excerpt from a files/ document. For PDFs, page selects which page to quote. The result includes the file title, path, and page.",
  inputSchema: {
    id: z.string().min(1).describe("Library file id"),
    page: z.number().int().positive().optional().describe("PDF page to quote"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ id, page }, ctx) => {
    const project = ctx.requireProject();
    const cited = await citeLibrary(project, id, page);
    if (!cited) throw new ToolError(`library file not found: ${id}`, "not_found");
    const where = cited.page ? `${cited.entry.title} p.${cited.page}` : cited.entry.title;
    const text = cited.text.trim() || "(No extractable text. Open the file in the Files tab.)";
    return ok(`${where} (${cited.entry.path})\n${text}`, {
      id: cited.entry.id,
      path: cited.entry.path,
      title: cited.entry.title,
      page: cited.page,
      text,
      linkedRefs: cited.entry.linkedRefs,
    });
  },
});

export const project_files_link = defineTool({
  name: "project_files_link",
  toolset: "project",
  title: "Link a library file to a component",
  description:
    "Attach a files/ document to schematic/PCB references or manufacturer part numbers, for example a datasheet to U1. Writes files/library.json (git-tracked).",
  inputSchema: {
    id: z.string().min(1),
    refs: z.array(z.string().min(1).max(80)).max(64).optional().describe("Component references such as U1"),
    mpns: z.array(z.string().min(1).max(80)).max(32).optional().describe("Manufacturer part numbers"),
    tags: z.array(z.string().min(1).max(40)).max(24).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ id, refs, mpns, tags }, ctx) => {
    const project = ctx.requireProject();
    const patch = LibraryEntryPatch.parse({
      ...(refs ? { linkedRefs: refs } : {}),
      ...(mpns ? { linkedMpns: mpns } : {}),
      ...(tags ? { tags } : {}),
    });
    const entry = await patchLibraryEntry(project, id, patch);
    const label = [
      entry.title,
      entry.linkedRefs.length ? `refs ${entry.linkedRefs.join(", ")}` : "",
      entry.linkedMpns.length ? `MPN ${entry.linkedMpns.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return ok(`Linked ${label}.`, { entry });
  },
});

export const libraryTools = [
  project_files_list,
  project_files_search,
  project_files_cite,
  project_files_link,
];
