/** Project-scoped pins and the shared notes sheet. */
import { z } from "zod/v4";
import {
  CommentArea,
  CommentStatus,
  CommentView,
  commentAnchorLabel,
  type BoardComment,
} from "@fabdesk/protocol";
import {
  createComment,
  loadComments,
  loadNotes,
  parseAnchorInput,
  patchComment,
  saveComments,
  saveNotes,
} from "../comments";
import { defineTool } from "../registry";
import { ok, table, trim } from "./common";

function commentRow(comment: BoardComment) {
  return {
    id: comment.id,
    status: comment.status,
    view: comment.anchor.view,
    where: commentAnchorLabel(comment.anchor),
    question: comment.question,
    ...(comment.answer ? { answer: comment.answer } : {}),
  };
}

export const comment_list = defineTool({
  name: "comment_list",
  toolset: "project",
  title: "List board comments",
  description:
    "List pins in comments.json and a short excerpt of NOTES.md, the shared notes sheet. Filter by view or status.",
  inputSchema: {
    view: CommentView.optional().describe("Only pins on this view"),
    status: CommentStatus.optional().describe("Only pins with this status"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ view, status }, ctx) => {
    const project = ctx.requireProject();
    const file = await loadComments(project);
    const notes = await loadNotes(project);
    const comments = file.comments.filter((comment) => {
      if (view && comment.anchor.view !== view) return false;
      if (status && comment.status !== status) return false;
      return true;
    });
    const excerpt = trim(notes, 2000);
    return ok(
      comments.length === 0
        ? `No pinned comments.${notes ? ` NOTES.md is ${notes.length} characters.` : " NOTES.md is empty."}`
        : `${table(comments.map(commentRow))}\n\nNOTES.md (${notes.length} chars):\n${excerpt || "(empty)"}`,
      {
        comments,
        notes: { path: "NOTES.md", chars: notes.length, excerpt },
      },
    );
  },
});

export const comment_pin = defineTool({
  name: "comment_pin",
  toolset: "project",
  title: "Pin a board comment",
  description:
    "Pin a question to a spot on the schematic, PCB, 3D view or product view. Write comments.json (git-tracked). Give a ref, net, area, or click coordinates so later inspect tools know what is under the pin.",
  inputSchema: {
    question: z.string().min(1).max(4000).describe("The question or note to pin"),
    view: CommentView.describe("Which drawing the pin sits on"),
    x: z.number().finite().optional().describe("SVG viewBox X of the click"),
    y: z.number().finite().optional().describe("SVG viewBox Y of the click"),
    xMm: z.number().finite().optional().describe("Design-space X in millimetres"),
    yMm: z.number().finite().optional().describe("Design-space Y in millimetres"),
    ref: z.string().min(1).max(80).optional().describe("Component reference, e.g. U12"),
    pin: z.string().min(1).max(40).optional().describe("Symbol pin number"),
    pad: z.string().min(1).max(40).optional().describe("Footprint pad number"),
    net: z.string().min(1).max(120).optional().describe("Net name under the pin"),
    area: CommentArea.optional().describe("Inclusive region instead of a point"),
    author: z.string().min(1).max(80).optional().describe("Who dropped the pin"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async (args, ctx) => {
    const project = ctx.requireProject();
    const anchor = parseAnchorInput({
      view: args.view,
      ...(args.x !== undefined ? { x: args.x } : {}),
      ...(args.y !== undefined ? { y: args.y } : {}),
      ...(args.xMm !== undefined ? { xMm: args.xMm } : {}),
      ...(args.yMm !== undefined ? { yMm: args.yMm } : {}),
      ...(args.ref ? { ref: args.ref } : {}),
      ...(args.pin ? { pin: args.pin } : {}),
      ...(args.pad ? { pad: args.pad } : {}),
      ...(args.net ? { net: args.net } : {}),
      ...(args.area ? { area: args.area } : {}),
    });
    const author = args.author ?? ctx.principal?.handle ?? ctx.principal?.subject ?? "local";
    const loaded = await loadComments(project);
    const { file, comment } = createComment(loaded, {
      question: args.question,
      anchor,
      ...(author ? { author } : {}),
    });
    await saveComments(project, file);
    return ok(`Pinned ${comment.id} on ${comment.anchor.view} · ${commentAnchorLabel(anchor)}.`, {
      comment,
      path: "comments.json",
    });
  },
});

export const comment_answer = defineTool({
  name: "comment_answer",
  toolset: "project",
  title: "Answer a board comment",
  description:
    "Write the agent's answer onto a pinned comment in comments.json. Status becomes answered unless you pass resolved. Ground the answer in pcb_inspect / schematic_inspect output for the pin.",
  inputSchema: {
    id: z.string().min(1).describe("Comment id from comment_list or comment_pin"),
    answer: z.string().min(1).max(20_000).describe("Answer grounded in the design"),
    status: CommentStatus.optional().describe("Defaults to answered"),
    answeredBy: z.string().min(1).max(80).optional().describe("Defaults to agent"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ id, answer, status, answeredBy }, ctx) => {
    const project = ctx.requireProject();
    const loaded = await loadComments(project);
    const { file, comment } = patchComment(loaded, id, {
      answer,
      ...(status ? { status } : {}),
      answeredBy: answeredBy ?? "agent",
    });
    await saveComments(project, file);
    return ok(`Answered ${comment.id} (${comment.status}).`, { comment, path: "comments.json" });
  },
});

export const comment_resolve = defineTool({
  name: "comment_resolve",
  toolset: "project",
  title: "Resolve a board comment",
  description: "Mark a pinned comment resolved (or reopen it) in comments.json.",
  inputSchema: {
    id: z.string().min(1).describe("Comment id"),
    status: z.enum(["resolved", "open"]).default("resolved"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ id, status }, ctx) => {
    const project = ctx.requireProject();
    const loaded = await loadComments(project);
    const { file, comment } = patchComment(loaded, id, { status });
    await saveComments(project, file);
    return ok(`${status === "open" ? "Reopened" : "Resolved"} ${comment.id}.`, {
      comment,
      path: "comments.json",
    });
  },
});

export const notes_read = defineTool({
  name: "notes_read",
  toolset: "project",
  title: "Read the board notes sheet",
  description: "Read NOTES.md, the shared notes sheet for this board. Empty if the file does not exist yet.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const content = await loadNotes(project);
    return ok(content ? trim(content, 50_000) : "NOTES.md is empty.", {
      path: "NOTES.md",
      content,
      chars: content.length,
    });
  },
});

export const notes_write = defineTool({
  name: "notes_write",
  toolset: "project",
  title: "Write the board notes sheet",
  description: "Create or overwrite NOTES.md, the shared notes sheet. Pass the full file contents.",
  inputSchema: {
    content: z.string().max(200_000).describe("Full Markdown contents of NOTES.md"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ content }, ctx) => {
    const project = ctx.requireProject();
    await saveNotes(project, content);
    return ok(`Wrote NOTES.md (${Buffer.byteLength(content)} bytes).`, {
      path: "NOTES.md",
      bytes: Buffer.byteLength(content),
    });
  },
});

export const commentTools = [
  comment_list,
  comment_pin,
  comment_answer,
  comment_resolve,
  notes_read,
  notes_write,
];
