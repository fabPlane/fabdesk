/** Git-native board comments (`comments.json`) and the shared notes sheet (`NOTES.md`). */
import { z } from "zod/v4";

export const BOARD_COMMENTS_FILE = "comments.json";
export const BOARD_NOTES_FILE = "NOTES.md";

export const BOARD_COMMENTS_CONTRACT = {
  name: "fabplane.board-comments",
  version: "1.0.0",
} as const;

export const CommentView = z.enum(["schematic", "pcb", "3d", "product"]);
export type CommentView = z.infer<typeof CommentView>;

export const CommentStatus = z.enum(["open", "answered", "resolved"]);
export type CommentStatus = z.infer<typeof CommentStatus>;

export const CommentArea = z
  .object({
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
    units: z.enum(["mm", "svg"]).default("mm"),
  })
  .refine((area) => area.maxX >= area.minX && area.maxY >= area.minY, {
    message: "area is inverted",
  });
export type CommentArea = z.infer<typeof CommentArea>;

export const CommentAnchor = z
  .object({
    view: CommentView,
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    xMm: z.number().finite().optional(),
    yMm: z.number().finite().optional(),
    ref: z.string().min(1).max(80).optional(),
    pin: z.string().min(1).max(40).optional(),
    pad: z.string().min(1).max(40).optional(),
    net: z.string().min(1).max(120).optional(),
    area: CommentArea.optional(),
  })
  .refine(
    (anchor) =>
      (anchor.x !== undefined && anchor.y !== undefined) ||
      (anchor.xMm !== undefined && anchor.yMm !== undefined) ||
      Boolean(anchor.ref) ||
      Boolean(anchor.net) ||
      Boolean(anchor.area),
    { message: "anchor needs a click (x/y or mm), a ref, a net, or an area" },
  );
export type CommentAnchor = z.infer<typeof CommentAnchor>;

export const BoardComment = z.object({
  id: z.string().min(1).regex(/^cmt_[a-z0-9_-]+$/i),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  author: z.string().min(1).max(80).default("local"),
  status: CommentStatus.default("open"),
  question: z.string().min(1).max(4000),
  anchor: CommentAnchor,
  answer: z.string().min(1).max(20_000).optional(),
  answeredAt: z.string().min(1).optional(),
  answeredBy: z.string().min(1).max(80).optional(),
  threadId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
});
export type BoardComment = z.infer<typeof BoardComment>;

export const BoardCommentsFile = z.object({
  contract: z.object({
    name: z.literal(BOARD_COMMENTS_CONTRACT.name),
    version: z.literal(BOARD_COMMENTS_CONTRACT.version),
  }),
  comments: z.array(BoardComment).max(500),
});
export type BoardCommentsFile = z.infer<typeof BoardCommentsFile>;

export const CreateBoardComment = z.object({
  question: z.string().min(1).max(4000),
  anchor: CommentAnchor,
  author: z.string().min(1).max(80).optional(),
});
export type CreateBoardComment = z.infer<typeof CreateBoardComment>;

export const PatchBoardComment = z.object({
  question: z.string().min(1).max(4000).optional(),
  answer: z.string().min(1).max(20_000).optional(),
  status: CommentStatus.optional(),
  answeredBy: z.string().min(1).max(80).optional(),
  threadId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  anchor: CommentAnchor.optional(),
});
export type PatchBoardComment = z.infer<typeof PatchBoardComment>;

export const WriteBoardNotes = z.object({
  content: z.string().max(200_000),
});
export type WriteBoardNotes = z.infer<typeof WriteBoardNotes>;

export function emptyBoardCommentsFile(): BoardCommentsFile {
  return { contract: { ...BOARD_COMMENTS_CONTRACT }, comments: [] };
}

/** Short label like `U12 · pad 1 · SPI.CS` or `pcb · (12.4, 8.0)`. */
export function commentAnchorLabel(anchor: CommentAnchor): string {
  const parts: string[] = [];
  if (anchor.ref) parts.push(anchor.ref);
  if (anchor.pad) parts.push(`pad ${anchor.pad}`);
  else if (anchor.pin) parts.push(`pin ${anchor.pin}`);
  if (anchor.net) parts.push(anchor.net);
  if (parts.length === 0 && anchor.area) {
    parts.push(
      `area ${fmt(anchor.area.minX)},${fmt(anchor.area.minY)}–${fmt(anchor.area.maxX)},${fmt(anchor.area.maxY)} ${anchor.area.units}`,
    );
  }
  if (parts.length === 0) {
    if (anchor.xMm !== undefined && anchor.yMm !== undefined)
      parts.push(`(${fmt(anchor.xMm)}, ${fmt(anchor.yMm)}) mm`);
    else if (anchor.x !== undefined && anchor.y !== undefined)
      parts.push(`(${fmt(anchor.x)}, ${fmt(anchor.y)})`);
  }
  return parts.length ? parts.join(" · ") : anchor.view;
}

/** Prompt an agent adapter should receive when answering a pin in place. */
export function buildCommentAskPrompt(comment: BoardComment): string {
  const locator = commentAnchorLabel(comment.anchor);
  const inspect =
    comment.anchor.view === "schematic"
      ? "schematic_inspect"
      : comment.anchor.view === "pcb"
        ? "pcb_inspect"
        : "design_inspect";
  const lines = [
    "Answer the pinned board comment below from what the design says is there.",
    `Use ${inspect} (and design_inspect if you need the wider net) with the reference, net, or nearby coordinates.`,
    "Then call comment_answer with this comment id. If the design does not say, say so.",
    "",
    `Comment id: ${comment.id}`,
    `View: ${comment.anchor.view}`,
    `Anchor: ${locator}`,
    `Question: ${comment.question}`,
  ];
  if (comment.anchor.ref) lines.push(`Reference: ${comment.anchor.ref}`);
  if (comment.anchor.net) lines.push(`Net: ${comment.anchor.net}`);
  if (comment.anchor.xMm !== undefined && comment.anchor.yMm !== undefined)
    lines.push(`Near (mm): ${comment.anchor.xMm}, ${comment.anchor.yMm}`);
  return lines.join("\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
