import { expect, test } from "bun:test";
import type { QuestionPart } from "@fabdesk/protocol";
import { useUiStore } from "../stores/ui";
import { reviewClosedQuestion } from "./review-closed-question";

const question: QuestionPart = { type: "question", requestId: "closed", question: "Which connector?", options: ["USB", "Header"], answer: "" };

test("closed-question recovery prepares a contextual unsent answer and preserves the existing draft", () => {
  const previous = useUiStore.getState();
  try {
    useUiStore.setState({ activeThreadId: "chat", drafts: { chat: "Keep my sourcing constraints." }, attachments: { chat: [{ path: "/sketch.png", mime: "image/png", label: "Sketch" }] } });
    expect(reviewClosedQuestion("chat", question, " USB ")).toBe(true);
    const draft = useUiStore.getState().drafts.chat ?? "";
    expect(draft).toBe("Keep my sourcing constraints.\n\nAbout your earlier question: Which connector?\nMy answer: USB");
    expect(useUiStore.getState().attachments.chat?.[0]?.path).toBe("/sketch.png");
    reviewClosedQuestion("chat", question, "USB");
    expect(useUiStore.getState().drafts.chat).toBe(draft);
    expect(useUiStore.getState().composerFocusNonce).toBeGreaterThan(previous.composerFocusNonce);
  } finally { useUiStore.setState(previous); }
});

test("recovery cannot answer a pending/resolved question or write into a different chat", () => {
  const previous = useUiStore.getState();
  try {
    useUiStore.setState({ activeThreadId: "other", drafts: {} });
    expect(reviewClosedQuestion("chat", question, "USB")).toBe(false);
    useUiStore.setState({ activeThreadId: "chat" });
    for (const answer of [null, "Header"]) expect(reviewClosedQuestion("chat", { ...question, answer }, "USB")).toBe(false);
    expect(reviewClosedQuestion("chat", question, " ")).toBe(false);
    expect(useUiStore.getState().drafts).toEqual({});
  } finally { useUiStore.setState(previous); }
});
