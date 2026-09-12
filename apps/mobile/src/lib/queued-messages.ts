/**
 * Messages typed while a run is live. The daemon holds them (`POST /threads/:id/messages?queue=1`)
 * and sends them when the run ends; until then `GET /threads/:id/messages` lists them with
 * `status: "queued"`. Pure, so Bun tests it.
 */
import type { QueuedMessage } from "@fabdesk/client-core";
import type { Message } from "@fabdesk/protocol";

export function isQueued(message: Message): boolean {
  return (message as QueuedMessage).status === "queued";
}

/** The still-queued messages, oldest first — the chips above the composer. */
export function queuedMessages(messages: readonly Message[] | undefined): Message[] {
  return (messages ?? []).filter(isQueued);
}

/**
 * What the primary composer button does and says. A slash draft turns it into Run (enabled once
 * the command parses) — a `/render` must never reach the agent as a message.
 */
export function composerAction(input: {
  running: boolean;
  hasContent: boolean;
  sending: boolean;
  /** `null` when the draft is not a slash command; otherwise whether it is complete. */
  slash?: "ready" | "incomplete" | null;
}): { kind: "send" | "queue" | "stop" | "run"; label: string; enabled: boolean } {
  if (input.slash) return { kind: "run", label: "Run", enabled: input.slash === "ready" };
  if (input.running) {
    // Stop is what a live run's button has always done; Queue takes over as soon as there is
    // something to queue, and Stop moves to a smaller button beside it.
    if (input.hasContent) return { kind: "queue", label: "Queue", enabled: !input.sending };
    return { kind: "stop", label: "Stop", enabled: true };
  }
  return { kind: "send", label: "Send", enabled: input.hasContent && !input.sending };
}

/** One line of a queued message for its chip: first line, trimmed, capped. */
export function chipLabel(message: Pick<Message, "contentMd" | "parts">, max = 60): string {
  const text = message.contentMd.trim().split(/\r?\n/, 1)[0] ?? "";
  const images = message.parts.filter((p) => p.type === "image").length;
  const base = text || (images ? `${images} photo${images === 1 ? "" : "s"}` : "(empty)");
  const withImages = text && images ? `${base} 📎` : base;
  return withImages.length > max ? `${withImages.slice(0, max - 1)}…` : withImages;
}
