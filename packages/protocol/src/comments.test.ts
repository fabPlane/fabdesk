import { describe, expect, test } from "bun:test";
import {
  BOARD_COMMENTS_CONTRACT,
  BOARD_COMMENTS_FILE,
  BOARD_NOTES_FILE,
  BoardComment,
  BoardCommentsFile,
  CommentAnchor,
  buildCommentAskPrompt,
  commentAnchorLabel,
  emptyBoardCommentsFile,
} from "./comments";

const pin = {
  id: "cmt_u12",
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  author: "maya",
  status: "open" as const,
  question: "What does this chip do here?",
  anchor: { view: "pcb" as const, x: 12.4, y: 8, ref: "U12", pad: "1", net: "SPI.CS" },
};

describe("board comments protocol", () => {
  test("matches the fabplane.com git-native filenames", () => {
    expect(BOARD_COMMENTS_FILE).toBe("comments.json");
    expect(BOARD_NOTES_FILE).toBe("NOTES.md");
    expect(emptyBoardCommentsFile().contract).toEqual(BOARD_COMMENTS_CONTRACT);
  });

  test("rejects a pin with no locator", () => {
    expect(CommentAnchor.safeParse({ view: "pcb" }).success).toBe(false);
    expect(CommentAnchor.safeParse({ view: "pcb", ref: "U12" }).success).toBe(true);
  });

  test("parses a file and labels the pin", () => {
    const parsed = BoardCommentsFile.parse({
      contract: BOARD_COMMENTS_CONTRACT,
      comments: [pin],
    });
    expect(commentAnchorLabel(parsed.comments[0]!.anchor)).toBe("U12 · pad 1 · SPI.CS");
  });

  test("ask prompt names the inspect tool and comment_answer", () => {
    const prompt = buildCommentAskPrompt(pin);
    expect(prompt).toContain("pcb_inspect");
    expect(prompt).toContain("comment_answer");
    expect(prompt).toContain("cmt_u12");
  });

  test("ask prompt includes Near (mm) when the pin stores millimetres", () => {
    const prompt = buildCommentAskPrompt({
      ...pin,
      anchor: { view: "pcb", coordinateSystem: "kicad-pcb-mm", x: 12.4, y: 8, xMm: 12.4, yMm: 8 },
    });
    expect(prompt).toContain("Near (mm): 12.4, 8");
  });

  test("loads fabplane-style ids such as cmt_2026.10", () => {
    expect(BoardComment.safeParse({ ...pin, id: "cmt_2026.10" }).success).toBe(true);
    expect(BoardComment.safeParse({ ...pin, id: "cmt_2026-10-08T00:00:00" }).success).toBe(true);
    expect(BoardComment.safeParse({ ...pin, id: "note_1" }).success).toBe(false);
    expect(BoardComment.safeParse({ ...pin, id: "cmt_" }).success).toBe(false);
    expect(BoardComment.safeParse({ ...pin, id: `cmt_${"a".repeat(80)}` }).success).toBe(false);
  });
});


test("legacy mixed drawing/mm anchors do not silently become native placement targets", () => {
  const prompt = buildCommentAskPrompt({ id: "cmt_legacy", createdAt: "now", updatedAt: "now", author: "local", status: "open", question: "Check this point", anchor: { view: "pcb", x: 7.5, y: 7.5, xMm: 7.5, yMm: 7.5 } });
  expect(prompt).not.toContain("Near (mm)");
  expect(prompt).toContain("drawing origin is unverified");
});
