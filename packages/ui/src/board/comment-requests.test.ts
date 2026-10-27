import { expect, test } from "bun:test";
import { buildCommentAskPrompt, type BoardComment } from "@fabdesk/protocol";
import { buildCommentsAskPrompt, pendingBoardComments } from "./comment-requests";

const pin = (id: string, patch: Partial<BoardComment> = {}): BoardComment => ({
  id, question: `Question for ${id}`, author: "test", status: "open",
  createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
  anchor: { view: "pcb", coordinateSystem: "kicad-pcb-mm", x: 10, y: 20, xMm: 10, yMm: 20 }, ...patch,
});

test("batch includes only unanswered open pins in the current view", () => {
  const comments = [pin("first"), pin("answered", { status: "answered", answer: "Done" }),
    pin("resolved", { status: "resolved" }), pin("has-answer", { answer: "Done" }),
    pin("schematic", { anchor: { view: "schematic", x: 2, y: 3 } }), pin("last")];
  const pending = pendingBoardComments(comments, "pcb");
  expect(pending.map(c => c.id)).toEqual(["first", "last"]);
  const prompt = buildCommentsAskPrompt(pending);
  expect(prompt).toContain("Review all 2 pinned board comments");
  for (const comment of pending) expect(prompt).toContain(buildCommentAskPrompt(comment));
  expect(prompt).not.toContain("Question for resolved");
  expect(prompt).not.toContain("Question for schematic");
  expect(prompt).toContain("comment_answer separately for every comment id");
});

test("single pin keeps its exact targeted prompt and empty batches send nothing", () => {
  expect(buildCommentsAskPrompt([pin("single")])).toBe(buildCommentAskPrompt(pin("single")));
  expect(buildCommentsAskPrompt([])).toBe("");
});
