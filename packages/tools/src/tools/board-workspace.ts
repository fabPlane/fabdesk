/** Board history across revisions, and part links across boards. */
import { z } from "zod/v4";
import { boardDrawingSvg, boardPairDrawings, boardSize, compareBoardPair, normalizeBoardOrigin } from "@fabdesk/board-diff";
import { PART_LINKS_FILE, PartEndpoint, PartPinPair, type BoardPartStatus, type BoardRevisionComparison, type BoardTimelineEntry, type PartLinkImpact } from "@fabdesk/protocol";
import { BOARD_WORKTREE_REF, assertPcbPath, listBoardRevisions, listProjectBoards, parseBoard, partSummaries, readBoardRevision, saveBoardPoint } from "../board-history";
import type { BoardPartRole, BoardPairComparison } from "@fabdesk/board-diff";
import {
  assertPinPairs,
  currentBoard,
  listPartLinks,
  loadPartLinks,
  newPartLinkId,
  partBaseline,
  resolvePartLinks,
  samePartLink,
  suggestPartLinks,
  updatePartLinks,
} from "../part-links";
import { ToolError, defineTool, type ProjectHandle } from "../registry";
import { ok, table } from "./common";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } as const;
/** What each part is against the older revision, for screens and agents alike. */
function partChanges(comparison: BoardPairComparison) {
  const status = new Map<string, BoardPartStatus>(), roles = new Map<string, BoardPartRole>();
  for (const change of comparison.changes) {
    if (!change.toRef) continue;
    status.set(change.toRef, change.kind === "added" ? "new" : "changed");
    roles.set(change.toRef, change.kind === "added" ? "added" : change.kind === "moved" ? "moved" : "changed");
  }
  return { status, roles };
}

/** A damaged links file is reported by the connection tools; it must not hide the boards themselves. */
async function linksOrNone(project: ProjectHandle) {
  try {
    return (await loadPartLinks(project)).links;
  } catch (error) {
    if (error instanceof ToolError && error.code === "precondition") return [];
    throw error;
  }
}

const PcbPath = z.string().min(1).max(500).describe("Project-relative .kicad_pcb path, as returned by board_list");

export const board_list = defineTool({
  name: "board_list",
  toolset: "project",
  title: "List project boards",
  description: "List the KiCad boards in this project. A declared assembly lists its available sources; otherwise this lists design PCBs and omits exported copies.",
  inputSchema: {},
  annotations: readOnly,
  handler: async (_args, ctx) => {
    const boards = await listProjectBoards(ctx.requireProject());
    return ok(boards.length ? table(boards.map((board) => ({ name: board.name, path: board.path }))) : "No KiCad boards in this project.", { boards });
  },
});

export const board_view = defineTool({
  name: "board_view",
  toolset: "project",
  title: "View a board's parts",
  description: "Read one board's placed parts, positions and nets, in millimetres from the board outline corner. Each part reports whether it is a connector, whether it is new, changed or existing against the previous revision, and which parts it is linked to. Set drawing to include an SVG.",
  inputSchema: {
    pcbPath: PcbPath,
    drawing: z.boolean().default(false).describe("Include an SVG drawing of the board"),
  },
  annotations: readOnly,
  handler: async ({ pcbPath, drawing }, ctx) => {
    const project = ctx.requireProject(), path = assertPcbPath(pcbPath);
    const revision = await readBoardRevision(project, path, BOARD_WORKTREE_REF, ctx.signal);
    const current = parseBoard(revision.text, revision.sha256);
    const { revisions } = await listBoardRevisions(project, path, 2, ctx.signal);
    const earlier = revisions.length > 1 ? revisions.at(-2)! : null;
    const comparison = earlier ? compareBoardPair(parseBoard(earlier.text, earlier.sha256), current) : null;
    const snapshot = comparison ? comparison.to : normalizeBoardOrigin(current);
    const changes = comparison ? partChanges(comparison) : null;
    const linkedTo = new Map<string, PartEndpoint[]>();
    for (const link of await linksOrNone(project)) {
      for (const [own, peer] of [[link.a, link.b], [link.b, link.a]] as const) {
        if (own.boardPath === path) linkedTo.set(own.ref, [...(linkedTo.get(own.ref) ?? []), peer]);
      }
    }
    const parts = partSummaries(snapshot, { linkedTo, ...(changes ? { status: changes.status, existing: true } : {}) });
    const count = (test: (part: (typeof parts)[number]) => boolean) => parts.filter(test).length;
    return ok(`${path}: ${parts.length} placed part(s), ${count((part) => part.connector)} connector(s), ${count((part) => !!part.linkedTo)} linked${earlier ? `; ${count((part) => part.status === "new")} new and ${count((part) => part.status === "changed")} changed since ${earlier.title}` : ""}.`, {
      pcbPath: path,
      label: revision.title,
      sha256: revision.sha256,
      size: boardSize(snapshot),
      parts,
      ...(earlier ? { baseline: { ref: earlier.ref, label: earlier.title } } : {}),
      ...(drawing ? { drawing: boardDrawingSvg(snapshot, changes ? { roles: changes.roles } : {}) } : {}),
    });
  },
});

export const board_revision_timeline = defineTool({
  name: "board_revision_timeline",
  toolset: "project",
  title: "Board revision timeline",
  description: "List one board's distinct revisions, oldest first, with the part changes from each to the next. Revisions come from git commits, saved points and exact copies in export bundles. Identical content appears once.",
  inputSchema: {
    pcbPath: PcbPath,
    limit: z.number().int().min(2).max(60).default(30),
  },
  annotations: readOnly,
  handler: async ({ pcbPath, limit }, ctx) => {
    const project = ctx.requireProject(), path = assertPcbPath(pcbPath);
    const { revisions, git, truncated } = await listBoardRevisions(project, path, limit, ctx.signal);
    const entries: BoardTimelineEntry[] = [];
    let previous: ReturnType<typeof parseBoard> | null = null;
    for (const revision of revisions) {
      const snapshot = parseBoard(revision.text, revision.sha256);
      entries.push({
        ref: revision.ref,
        kind: revision.kind,
        title: revision.title,
        ...(revision.date ? { date: revision.date } : {}),
        sha256: revision.sha256,
        parts: snapshot.components.length,
        size: boardSize(snapshot),
        ...(previous ? { changes: compareBoardPair(previous, snapshot).summary } : {}),
      });
      previous = snapshot;
    }
    return ok(`${path}: ${entries.length} distinct revision(s).`, { pcbPath: path, entries, git, truncated });
  },
});

export const board_revision_compare = defineTool({
  name: "board_revision_compare",
  toolset: "project",
  title: "Compare two board revisions",
  description: "Compare two revisions of one board by part: added, removed, moved, changed and renamed, in outline coordinates so sheet position is ignored. Refs are worktree, a git commit, saved:<sha256>, or file:<path> for another PCB in this project. Also reports linked parts on other boards that the change touches. Set drawings for older and newer SVGs at one scale. Writes nothing.",
  inputSchema: {
    pcbPath: PcbPath,
    from: z.string().min(1).max(600).describe("Older revision ref"),
    to: z.string().min(1).max(600).default(BOARD_WORKTREE_REF).describe("Newer revision ref"),
    drawings: z.boolean().default(false).describe("Include SVG drawings of both revisions"),
  },
  annotations: readOnly,
  handler: async ({ pcbPath, from, to, drawings }, ctx) => {
    const project = ctx.requireProject(), path = assertPcbPath(pcbPath);
    const [older, newer] = await Promise.all([readBoardRevision(project, path, from, ctx.signal), readBoardRevision(project, path, to, ctx.signal)]);
    const comparison = compareBoardPair(parseBoard(older.text, older.sha256), parseBoard(newer.text, newer.sha256));
    const art = drawings ? boardPairDrawings(comparison) : null;
    const links = await linksOrNone(project);
    const impacts: PartLinkImpact[] = [];
    for (const change of comparison.changes) {
      for (const link of links) {
        for (const [own, peer] of [[link.a, link.b], [link.b, link.a]] as const) {
          if (own.boardPath === path && (own.ref === change.fromRef || own.ref === change.toRef)) impacts.push({ linkId: link.id, changedRef: own.ref, change: change.kind, peer });
        }
      }
    }
    const result: BoardRevisionComparison = {
      pcbPath: path,
      from: { ref: older.ref, label: older.title, sha256: older.sha256, size: boardSize(comparison.from), parts: partSummaries(comparison.from), ...(art ? { drawing: art.from } : {}) },
      to: { ref: newer.ref, label: newer.title, sha256: newer.sha256, size: boardSize(comparison.to), parts: partSummaries(comparison.to, { status: partChanges(comparison).status, existing: true }), ...(art ? { drawing: art.to } : {}) },
      summary: comparison.summary,
      changes: comparison.changes,
      nets: { added: comparison.diff.nets.added.length, removed: comparison.diff.nets.removed.length, changed: comparison.diff.nets.changed.length },
      copper: { tracksAdded: comparison.diff.tracks.added.length, tracksRemoved: comparison.diff.tracks.removed.length },
      impacts,
    };
    const { added, removed, moved, changed, renamed } = comparison.summary;
    return ok(`${path}: +${added} added, -${removed} removed, ${moved} moved, ${changed} changed, ${renamed} renamed.${impacts.length ? ` ${impacts.length} linked part(s) on other boards are affected.` : ""}`, result);
  },
});

export const board_revision_save = defineTool({
  name: "board_revision_save",
  toolset: "project",
  title: "Save a board revision",
  description: "Save a board's current saved bytes as a point on its timeline, without git and without modifying the design. Identical content keeps its earlier point.",
  inputSchema: {
    pcbPath: PcbPath,
    label: z.string().trim().min(1).max(120).default("Saved point"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ pcbPath, label }, ctx) => {
    const point = await saveBoardPoint(ctx.requireProject(), pcbPath, label);
    return ok(point.created ? "Saved this revision. Design files are unchanged." : "This exact revision was already saved.", point);
  },
});

export const connection_list = defineTool({
  name: "connection_list",
  toolset: "project",
  title: "List part connections",
  description: `List part links across boards from ${PART_LINKS_FILE}, each marked current, needs-review or missing against the boards as saved now, with nets that share a name and a pin check that compares net names across each stated pin. Also lists connections declared by the enclosure design or assembly manifest. A link records intent; it is not an electrical check.`,
  inputSchema: {},
  annotations: readOnly,
  handler: async (_args, ctx) => {
    const list = await listPartLinks(ctx.requireProject(), ctx.signal);
    return ok(
      list.links.length
        ? table(list.links.map((link) => ({ id: link.id, a: `${link.a.boardPath}#${link.a.ref}`, b: `${link.b.boardPath}#${link.b.ref}`, state: link.state, pins: link.pins?.length ?? 0, pinCheck: link.check.status, sharedNets: link.sharedNets.length })))
        : "No part links yet.",
      list,
    );
  },
});

export const connection_add = defineTool({
  name: "connection_add",
  toolset: "project",
  title: "Link two parts",
  description: `Record that a part on one board connects to a part on another, in ${PART_LINKS_FILE}, optionally with which pin goes to which pin. Both parts must exist in the saved boards. This does not change either board and does not verify electrical compatibility.`,
  inputSchema: {
    a: PartEndpoint,
    b: PartEndpoint,
    name: z.string().trim().max(160).optional(),
    note: z.string().trim().max(2000).optional(),
    pins: z.array(PartPinPair).max(2000).optional().describe("Which pin on a goes to which pin on b"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  handler: async ({ a, b, name, note, pins }, ctx) => {
    const project = ctx.requireProject();
    if (a.boardPath === b.boardPath && a.ref === b.ref) throw new ToolError("Choose two different parts.", "invalid_args");
    const part = async (endpoint: PartEndpoint) => {
      const board = await currentBoard(project, endpoint.boardPath, ctx.signal);
      if (!board) throw new ToolError(`No board at ${endpoint.boardPath}`, "not_found");
      const found = board.components.find((component) => component.ref === endpoint.ref);
      if (!found) throw new ToolError(`${endpoint.ref} is not on ${endpoint.boardPath}`, "not_found");
      return found;
    };
    const [partA, partB] = await Promise.all([part(a), part(b)]);
    assertPinPairs(partA, partB, pins ?? []);
    const link = await updatePartLinks(project, async (file) => {
      if (file.links.some((existing) => samePartLink(existing, a, b))) throw new ToolError("These parts are already linked.", "precondition");
      const now = new Date().toISOString();
      const created = {
        id: newPartLinkId(), a, b,
        ...(name ? { name } : {}),
        ...(note ? { note } : {}),
        ...(pins?.length ? { pins } : {}),
        createdAt: now,
        reviewedAt: now,
        baseline: { a: partBaseline(partA), b: partBaseline(partB) },
      };
      return { file: { ...file, links: [...file.links, created] }, result: created };
    });
    return ok(`Linked ${a.ref} and ${b.ref}.`, { link });
  },
});

export const connection_remove = defineTool({
  name: "connection_remove",
  toolset: "project",
  title: "Remove a part link",
  description: `Remove one link from ${PART_LINKS_FILE}. Neither board changes.`,
  inputSchema: { id: z.string().min(1).max(40) },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  handler: async ({ id }, ctx) => {
    const removed = await updatePartLinks(ctx.requireProject(), async (file) => ({ file: { ...file, links: file.links.filter((link) => link.id !== id) }, result: file.links.some((link) => link.id === id) }));
    return ok(removed ? "Removed the link." : "No link with that id.", { removed });
  },
});

export const connection_review = defineTool({
  name: "connection_review",
  toolset: "project",
  title: "Mark a part link reviewed",
  description: "Record that a link marked needs-review still holds for its parts as saved now, which clears its review state until either part changes again. This is a person's or agent's judgment, not an electrical check.",
  inputSchema: { id: z.string().min(1).max(40) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ id }, ctx) => {
    const project = ctx.requireProject();
    const link = await updatePartLinks(project, async (file) => {
      const existing = file.links.find((row) => row.id === id);
      if (!existing) throw new ToolError(`No link ${id}`, "not_found");
      const [boardA, boardB] = await Promise.all([currentBoard(project, existing.a.boardPath, ctx.signal), currentBoard(project, existing.b.boardPath, ctx.signal)]);
      const partA = boardA?.components.find((component) => component.ref === existing.a.ref), partB = boardB?.components.find((component) => component.ref === existing.b.ref);
      if (!partA || !partB) throw new ToolError("A linked part is missing. Remove this link or restore the part.", "precondition");
      const reviewed = { ...existing, reviewedAt: new Date().toISOString(), baseline: { a: partBaseline(partA), b: partBaseline(partB) } };
      return { file: { ...file, links: file.links.map((row) => (row.id === id ? reviewed : row)) }, result: reviewed };
    });
    return ok(`Marked ${link.a.ref} and ${link.b.ref} reviewed.`, { link });
  },
});

export const connection_set_pins = defineTool({
  name: "connection_set_pins",
  toolset: "project",
  title: "Set a part link's pin map",
  description: "Replace which pin on end a of a link goes to which pin on end b. Each pin must exist on its part as saved now. An empty list clears the map. This records intent and does not verify electrical compatibility.",
  inputSchema: {
    id: z.string().min(1).max(40),
    pins: z.array(PartPinPair).max(2000),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ id, pins }, ctx) => {
    const project = ctx.requireProject();
    const link = await updatePartLinks(project, async (file) => {
      const existing = file.links.find((row) => row.id === id);
      if (!existing) throw new ToolError(`No link ${id}`, "not_found");
      const [boardA, boardB] = await Promise.all([currentBoard(project, existing.a.boardPath, ctx.signal), currentBoard(project, existing.b.boardPath, ctx.signal)]);
      const partA = boardA?.components.find((component) => component.ref === existing.a.ref), partB = boardB?.components.find((component) => component.ref === existing.b.ref);
      if (!partA || !partB) throw new ToolError("A linked part is missing. Remove this link or restore the part.", "precondition");
      assertPinPairs(partA, partB, pins);
      const { pins: _previous, ...rest } = existing;
      const updated = { ...rest, ...(pins.length ? { pins } : {}) };
      return { file: { ...file, links: file.links.map((row) => (row.id === id ? updated : row)) }, result: updated };
    });
    const [resolved] = await resolvePartLinks(project, [link], ctx.signal);
    const check = resolved?.check;
    return ok(`${pins.length} pin pair(s) saved for ${link.a.ref} and ${link.b.ref}. Pin check by net name: ${check?.status ?? "none"}.`, { link, ...(check ? { check } : {}) });
  },
});

export const connection_suggest = defineTool({
  name: "connection_suggest",
  toolset: "project",
  title: "Suggest part links",
  description: "Suggest parts on two boards that may be related because their pads share net names, with connectors first. Names matching across boards is only a hint. Nothing is saved until connection_add.",
  inputSchema: {
    boardA: PcbPath,
    boardB: PcbPath,
    limit: z.number().int().min(1).max(50).default(12),
  },
  annotations: readOnly,
  handler: async ({ boardA, boardB, limit }, ctx) => {
    const project = ctx.requireProject();
    const [a, b] = await Promise.all([currentBoard(project, assertPcbPath(boardA), ctx.signal), currentBoard(project, assertPcbPath(boardB), ctx.signal)]);
    if (!a || !b) throw new ToolError("One of these boards is missing.", "not_found");
    const suggestions = suggestPartLinks(boardA, a, boardB, b, limit);
    return ok(suggestions.length ? `${suggestions.length} possible link(s) by shared net name.` : "No parts share a named net.", { suggestions });
  },
});

export const boardWorkspaceTools = [board_list, board_view, board_revision_timeline, board_revision_compare, board_revision_save, connection_list, connection_add, connection_remove, connection_review, connection_set_pins, connection_suggest];
