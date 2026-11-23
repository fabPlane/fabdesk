import { expect, test } from "bun:test";
import { attachmentsFromImageParts, imagePartsFromAttachments } from "../src/message-attachments";

test("queued markup attachments keep their role through stored image parts", () => {
  const parts = imagePartsFromAttachments([
    { path: "sketches/a.png", mime: "image/png" },
    { path: "sketches/m.png", mime: "image/png", role: "markup" },
  ]);
  expect(parts).toEqual([
    { type: "image", path: "sketches/a.png", mime: "image/png" },
    { type: "image", path: "sketches/m.png", mime: "image/png", role: "markup" },
  ]);
  expect(attachmentsFromImageParts(parts)).toEqual([
    { path: "sketches/a.png", mime: "image/png" },
    { path: "sketches/m.png", mime: "image/png", role: "markup" },
  ]);
});

test("an omitted or undefined role is dropped so stored parts stay exact-optional", () => {
  expect(imagePartsFromAttachments([{ path: "sketches/a.png", mime: "image/png", role: undefined }])).toEqual([
    { type: "image", path: "sketches/a.png", mime: "image/png" },
  ]);
});
