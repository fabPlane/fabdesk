import { expect, test } from "bun:test";
import { Message } from "./api";
import { MessagePart } from "./events";

test("image parts keep a markup role through message storage", () => {
  const part = MessagePart.parse({
    type: "image",
    path: "sketches/m.png",
    mime: "image/png",
    role: "markup",
  });
  expect(part).toEqual({ type: "image", path: "sketches/m.png", mime: "image/png", role: "markup" });
  const queued = Message.parse({
    id: "msg-1",
    threadId: "thread-1",
    role: "user",
    contentMd: "what is this net",
    parts: [part],
    runId: null,
    status: "queued",
    createdAt: "2026-11-09T00:00:00Z",
  });
  expect(queued.parts[0]).toEqual(part);
});
