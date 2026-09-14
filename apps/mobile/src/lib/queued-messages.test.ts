import { describe, expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { chipLabel, composerAction, isQueued, queuedMessages } from "./queued-messages";

const msg = (id: string, over: Partial<Message> & { status?: string } = {}): Message =>
  ({
    id,
    threadId: "t1",
    role: "user",
    contentMd: "hello",
    parts: [{ type: "text", text: "hello" }],
    runId: null,
    createdAt: "2026-09-13T00:00:00Z",
    ...over,
  }) as Message;

describe("queued messages", () => {
  test("a message is queued only when the daemon says so", () => {
    expect(isQueued(msg("a"))).toBe(false);
    expect(isQueued(msg("b", { status: "queued" }))).toBe(true);
    expect(isQueued(msg("c", {}))).toBe(false);
  });

  test("lists the queued ones in order, and copes with no messages", () => {
    const list = [msg("a"), msg("b", { status: "queued" }), msg("c", { status: "queued" })];
    expect(queuedMessages(list).map((m) => m.id)).toEqual(["b", "c"]);
    expect(queuedMessages(undefined)).toEqual([]);
  });
});

describe("composerAction", () => {
  test("idle: Send, enabled only with content", () => {
    expect(composerAction({ running: false, hasContent: true, sending: false })).toEqual({
      kind: "send",
      label: "Send",
      enabled: true,
    });
    expect(composerAction({ running: false, hasContent: false, sending: false }).enabled).toBe(
      false,
    );
  });

  test("live run with an empty draft: Stop", () => {
    expect(composerAction({ running: true, hasContent: false, sending: false })).toMatchObject({
      kind: "stop",
      enabled: true,
    });
  });

  test("a slash draft is Run, enabled once it parses, whatever the run state", () => {
    expect(
      composerAction({ running: true, hasContent: true, sending: false, slash: "ready" }),
    ).toEqual({ kind: "run", label: "Run", enabled: true });
    expect(
      composerAction({ running: false, hasContent: true, sending: false, slash: "incomplete" })
        .enabled,
    ).toBe(false);
    expect(
      composerAction({ running: false, hasContent: true, sending: false, slash: null }).kind,
    ).toBe("send");
  });

  test("live run with a draft: Queue, held while a queue request is in flight", () => {
    expect(composerAction({ running: true, hasContent: true, sending: false })).toEqual({
      kind: "queue",
      label: "Queue",
      enabled: true,
    });
    expect(composerAction({ running: true, hasContent: true, sending: true }).enabled).toBe(false);
  });
});

describe("chipLabel", () => {
  test("first line, trimmed and capped", () => {
    expect(chipLabel({ contentMd: "  route it\nthen render", parts: [] })).toBe("route it");
    expect(chipLabel({ contentMd: "x".repeat(80), parts: [] }, 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("photos without text say so; with text they get a clip", () => {
    const img = { type: "image", path: "sketches/a.png", mime: "image/png" } as const;
    expect(chipLabel({ contentMd: "", parts: [img] })).toBe("1 photo");
    expect(chipLabel({ contentMd: "", parts: [img, img] })).toBe("2 photos");
    expect(chipLabel({ contentMd: "look", parts: [img] })).toBe("look 📎");
    expect(chipLabel({ contentMd: "", parts: [] })).toBe("(empty)");
  });
});
