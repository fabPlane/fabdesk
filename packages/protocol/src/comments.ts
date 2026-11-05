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
    coordinateSystem: z.enum(["kicad-pcb-mm", "svg"]).optional(),
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
  id: z
    .string()
    .min(5)
    .max(80)
    .regex(/^cmt_[A-Za-z0-9._:-]+$/, "comment id must start with cmt_ and use a short identifier charset"),
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

/** Legacy PCB pins copied SVG x/y into xMm/yMm without recording the origin. */
export function commentMillimetrePoint(anchor: CommentAnchor): { x: number; y: number } | null {
  if (anchor.coordinateSystem === "svg") return null;
  if (anchor.view === "pcb" && anchor.coordinateSystem !== "kicad-pcb-mm" && (anchor.x !== undefined || anchor.y !== undefined)) return null;
  if (anchor.xMm !== undefined && anchor.yMm !== undefined) return { x: anchor.xMm, y: anchor.yMm };
  if (anchor.coordinateSystem === "kicad-pcb-mm" && anchor.x !== undefined && anchor.y !== undefined) return { x: anchor.x, y: anchor.y };
  return null;
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
    const native = commentMillimetrePoint(anchor);
    if (native) parts.push(`(${fmt(native.x)}, ${fmt(native.y)}) mm`);
    else if (anchor.x !== undefined && anchor.y !== undefined)
      parts.push(`(${fmt(anchor.x)}, ${fmt(anchor.y)})${anchor.view === "pcb" ? " drawing units" : ""}`);
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
  const native = commentMillimetrePoint(comment.anchor);
  if (native) lines.push(`Near (mm): ${native.x}, ${native.y}`);
  else if (comment.anchor.view === "pcb" && (comment.anchor.x !== undefined || comment.anchor.y !== undefined))
    lines.push("The drawing origin is unverified. Do not use these drawing coordinates as native PCB millimetres. Locate the reference/net or ask the user to re-pin this comment on an updated preview.");
  return lines.join("\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
