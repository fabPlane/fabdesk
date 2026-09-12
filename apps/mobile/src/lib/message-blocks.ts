/**
 * Turning a message's parts into what the chat screen draws. Pure, and deliberately free of any
 * React Native import so it can be unit-tested under Bun.
 */
import type { MessagePart } from "@fabdesk/protocol";
import type { AnyPart, ApprovalPart, QuestionPart } from "./pending-requests";

export type Block =
  | { kind: "text"; text: string; last: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "tools"; parts: MessagePart[] }
  | { kind: "image"; path: string }
  | { kind: "approval"; part: ApprovalPart }
  | { kind: "question"; part: QuestionPart };

/**
 * Groups a flat part list into what the screen actually draws. Accepts the supervised-mode parts
 * too (`approval`, `question`): each is a card of its own, and it also closes the tool group
 * before it, since the paused tool call is exactly what the card is about.
 */
export function toBlocks(parts: readonly AnyPart[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const isLast = i === parts.length - 1;
    if (part.type === "text") blocks.push({ kind: "text", text: part.text, last: isLast });
    else if (part.type === "thinking") blocks.push({ kind: "thinking", text: part.text });
    else if (part.type === "image") blocks.push({ kind: "image", path: part.path });
    else if (part.type === "approval") blocks.push({ kind: "approval", part });
    else if (part.type === "question") blocks.push({ kind: "question", part });
    else {
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "tools") prev.parts.push(part);
      else blocks.push({ kind: "tools", parts: [part] });
    }
  }
  return blocks;
}

/** What a collapsed tool group says about itself, without expanding it. */
export function summarizeTools(parts: readonly MessagePart[]): {
  label: string;
  errors: number;
  pending: boolean;
} {
  const uses = parts.filter((p) => p.type === "tool_use");
  const results = parts.filter((p) => p.type === "tool_result");
  const errors = results.filter((p) => p.type === "tool_result" && p.isError).length;
  const pending = uses.length > results.length;
  const names = uses.map((p) => (p.type === "tool_use" ? p.name : "")).filter(Boolean);
  const label =
    names.length === 0
      ? "tool results"
      : names.length === 1
        ? names[0]!
        : `${names.length} tool calls · ${names.slice(-2).join(", ")}`;
  return { label, errors, pending };
}
