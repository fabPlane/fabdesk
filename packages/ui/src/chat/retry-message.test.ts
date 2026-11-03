import { expect, test } from "bun:test";
import type { Message } from "@fabdesk/protocol";
import { useUiStore } from "../stores/ui";
import { reviewFailedPrompt } from "./retry-message";

const prompt: Message = { id: "prompt", threadId: "chat", role: "user", runId: null, createdAt: "", contentMd: "Plan a night light", parts: [{ type: "image", path: "/project/sketches/light.png", mime: "image/png" }] };

test("review restores the failed prompt and attachments without sending it", () => {
  const previous = useUiStore.getState();
  try {
    useUiStore.setState({ activeThreadId: "chat", drafts: {}, attachments: {} });
    expect(reviewFailedPrompt(prompt)).toBe(true);
    expect(useUiStore.getState().drafts.chat).toBe("Plan a night light");
    expect(useUiStore.getState().attachments.chat).toEqual([{ path: "/project/sketches/light.png", mime: "image/png", label: "light.png" }]);
    reviewFailedPrompt(prompt);
    expect(useUiStore.getState().attachments.chat).toHaveLength(1);
  } finally { useUiStore.setState(previous); }
});

test("review never overwrites a new draft or its attachments", () => {
  const previous = useUiStore.getState();
  try {
    useUiStore.setState({ activeThreadId: "chat", drafts: { chat: "My revised request" }, attachments: { chat: [{ path: "/new.png", mime: "image/png", label: "new.png" }] } });
    reviewFailedPrompt(prompt);
    expect(useUiStore.getState().drafts.chat).toBe("My revised request");
    expect(useUiStore.getState().attachments.chat).toHaveLength(1);
    expect(useUiStore.getState().attachments.chat?.[0]?.path).toBe("/new.png");
    useUiStore.setState({ drafts: { chat: "" } });
    reviewFailedPrompt(prompt);
    expect(useUiStore.getState().drafts.chat).toBe("");
    expect(useUiStore.getState().attachments.chat?.[0]?.path).toBe("/new.png");
  } finally { useUiStore.setState(previous); }
});

test("a stale error cannot copy content into another chat", () => {
  const previous = useUiStore.getState();
  try {
    useUiStore.setState({ activeThreadId: "other", drafts: {}, attachments: {} });
    expect(reviewFailedPrompt(prompt)).toBe(false);
    expect(useUiStore.getState().drafts).toEqual({});
  } finally { useUiStore.setState(previous); }
});
