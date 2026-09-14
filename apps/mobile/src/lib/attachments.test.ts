import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentsBlockedReason,
  attachmentsSettled,
  messageContent,
  preflightImage,
  toMessageAttachments,
  uploadName,
  type PendingAttachment,
} from "./attachments";

const NOW = 1_700_000_000_000;

describe("preflightImage", () => {
  test("takes the picker's mime when it has one", () => {
    expect(preflightImage({ uri: "file:///x/IMG_0001.HEIC", mimeType: "image/jpeg" }, NOW)).toEqual(
      {
        ok: true,
        mime: "image/jpeg",
        name: `photo-${NOW}.jpg`,
      },
    );
  });

  test("falls back to the extension of the file name, then the uri", () => {
    expect(preflightImage({ uri: "file:///x/a.png", fileName: "board.PNG" }, NOW)).toMatchObject({
      ok: true,
      mime: "image/png",
      name: `board-${NOW}.png`,
    });
    expect(preflightImage({ uri: "content://media/1.jpeg?x=1" }, NOW)).toMatchObject({
      ok: true,
      mime: "image/jpeg",
    });
  });

  test("refuses anything that is not PNG or JPEG before uploading it", () => {
    expect(preflightImage({ uri: "file:///x/a.gif", mimeType: "image/gif" }, NOW)).toMatchObject({
      ok: false,
    });
    expect(preflightImage({ uri: "file:///x/clip.mp4" }, NOW)).toMatchObject({ ok: false });
  });

  test("refuses oversized files with a size in the reason", () => {
    const out = preflightImage({ uri: "file:///x/a.jpg", fileSize: ATTACHMENT_MAX_BYTES + 1 }, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("20 MB");
  });
});

describe("uploadName", () => {
  test("keeps a sanitised stem, forces the extension to match the mime, and stamps the time", () => {
    expect(uploadName("My Photo (1).jpeg", "image/jpeg", NOW)).toBe(`My-Photo-1-${NOW}.jpg`);
    expect(uploadName("weird.heic", "image/png", NOW)).toBe(`weird-${NOW}.png`);
    expect(uploadName(null, "image/jpeg", NOW)).toBe(`photo-${NOW}.jpg`);
    expect(uploadName("!!!", "image/jpeg", NOW)).toBe(`photo-${NOW}.jpg`);
  });
});

const uploaded: PendingAttachment = {
  key: "1",
  localUri: "file:///a.jpg",
  mime: "image/jpeg",
  name: "a.jpg",
  path: "sketches/a.jpg",
};
const inflight: PendingAttachment = {
  key: "2",
  localUri: "file:///b.png",
  mime: "image/png",
  name: "b.png",
};
const failed: PendingAttachment = { ...inflight, key: "3", error: "415" };

describe("message assembly", () => {
  test("only stored files go on the wire", () => {
    expect(toMessageAttachments([uploaded, inflight, failed])).toEqual([
      { path: "sketches/a.jpg", mime: "image/jpeg" },
    ]);
  });

  test("attachmentsSettled waits for uploads and blocks on failures", () => {
    expect(attachmentsSettled([])).toBe(true);
    expect(attachmentsSettled([uploaded])).toBe(true);
    expect(attachmentsSettled([uploaded, inflight])).toBe(false);
    expect(attachmentsSettled([{ ...uploaded, error: "x" }])).toBe(false);
  });

  test("messageContent gives a photo-only message a stand-in caption", () => {
    expect(messageContent("  look at this ", [uploaded])).toBe("look at this");
    expect(messageContent("", [uploaded])).toBe("(see attached image)");
    expect(messageContent("", [inflight])).toBe("");
    expect(messageContent("   ", [])).toBe("");
  });
});

describe("attachmentsBlockedReason", () => {
  test("explains the project requirement in one line", () => {
    expect(attachmentsBlockedReason({ projectId: "p1" })).toBeNull();
    expect(attachmentsBlockedReason({ projectId: null })).toMatch(/project/);
    expect(attachmentsBlockedReason(undefined)).not.toBeNull();
  });
});
