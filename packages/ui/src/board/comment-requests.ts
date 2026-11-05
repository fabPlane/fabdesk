import { buildCommentAskPrompt, type BoardComment, type CommentView } from "@fabdesk/protocol";

export function pendingBoardComments(comments: readonly BoardComment[], view: CommentView): BoardComment[] {
  return comments.filter(comment => comment.anchor.view === view && comment.status === "open" && !comment.answer);
}

/** One chat message, with an explicit answer target for every saved pin. */
export function buildCommentsAskPrompt(comments: readonly BoardComment[]): string {
  if (comments.length === 0) return "";
  if (comments.length === 1) return buildCommentAskPrompt(comments[0]!);
  return [
    `Review all ${comments.length} pinned board comments below in one request.`,
    "Inspect each location and call comment_answer separately for every comment id. Keep each answer attached to its own pin.",
    ...comments.map((comment, index) => `\n--- Pin ${index + 1} ---\n${buildCommentAskPrompt(comment)}`),
  ].join("\n");
}

/** Keep the editable question readable; exact pin IDs and native tool instructions travel as context. */
export function buildCommentsUserPrompt(comments: readonly BoardComment[]): string {
  if (!comments.length) return "";
  if (comments.length === 1) return `Review this pinned comment: ${comments[0]!.question}\n\nInspect the saved location and save your answer to this pin. Explain anything that still needs checking.`;
  return [`Review these ${comments.length} pinned comments and save each answer to its own pin. Explain anything that still needs checking.`, ...comments.map((comment, index) => `${index + 1}. ${comment.question}`)].join("\n\n");
}
