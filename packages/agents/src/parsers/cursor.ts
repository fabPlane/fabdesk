import type { AgentEvent } from "../types";
import { asArray, isRecord } from "./messages";

/**
 * Parser for `agent -p --output-format stream-json [--stream-partial-output]` (Cursor CLI).
 * Events: `system/init`, `user`, `assistant`, `tool_call` (started|completed), `result`.
 *
 * With `--stream-partial-output` an assistant line carrying `timestamp_ms` but no `model_call_id`
 * is a fresh delta; one with `model_call_id` is a buffered duplicate flushed before a tool call;
 * one with neither is the final flush (a duplicate when deltas were streamed).
 */
export class CursorStreamParser {
  sessionId: string | undefined;
  private streamedSinceFlush = false;
  private readonly startedTools = new Set<string>();

  feed(line: unknown): AgentEvent[] {
    if (!isRecord(line)) return [];
    if (typeof line["session_id"] === "string") this.sessionId = line["session_id"];
    switch (line["type"]) {
      case "system":
        if (line["subtype"] !== "init") return [];
        return [
          {
            type: "init",
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(typeof line["model"] === "string" ? { model: line["model"] } : {}),
          },
        ];
      case "assistant":
        return this.onAssistant(line);
      case "tool_call":
        return this.onToolCall(line);
      case "result": {
        const events: AgentEvent[] = [];
        if (line["is_error"] === true) {
          events.push({
            type: "error",
            message:
              typeof line["result"] === "string" && line["result"] !== ""
                ? line["result"]
                : "cursor agent failed",
          });
        }
        return events;
      }
      default:
        return [];
    }
  }

  private onAssistant(line: Record<string, unknown>): AgentEvent[] {
    const text = messageText(line["message"]);
    if (text === "") return [];
    const hasTimestamp = line["timestamp_ms"] !== undefined;
    const hasCallId = line["model_call_id"] !== undefined;
    if (hasCallId) return []; // buffered duplicate before a tool call
    if (hasTimestamp) {
      this.streamedSinceFlush = true;
      return [{ type: "text", delta: text }];
    }
    // Final flush of a complete message.
    if (this.streamedSinceFlush) {
      this.streamedSinceFlush = false;
      return [];
    }
    return [{ type: "text", delta: text }];
  }

  private onToolCall(line: Record<string, unknown>): AgentEvent[] {
    const id =
      typeof line["call_id"] === "string" ? line["call_id"] : `call_${this.startedTools.size}`;
    const call = isRecord(line["tool_call"]) ? line["tool_call"] : {};
    const { name, args, result } = describeToolCall(call);
    const events: AgentEvent[] = [];
    if (!this.startedTools.has(id)) {
      this.startedTools.add(id);
      events.push({ type: "tool_use", id, name, input: args });
    }
    if (line["subtype"] === "completed") {
      const isError =
        isRecord(result) && (result["error"] !== undefined || result["success"] === false);
      events.push({
        type: "tool_result",
        id,
        output: result,
        ...(isError ? { isError: true } : {}),
      });
    }
    return events;
  }
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message["content"];
  if (typeof content === "string") return content;
  return asArray(content)
    .filter(isRecord)
    .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string)
    .join("");
}

/** Cursor wraps each call in a `<kind>ToolCall` key (readToolCall, writeToolCall…) or a generic `function`. */
function describeToolCall(call: Record<string, unknown>): {
  name: string;
  args: unknown;
  result: unknown;
} {
  const fn = call["function"];
  if (isRecord(fn)) {
    let args: unknown = fn["arguments"];
    if (typeof args === "string") {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        /* keep the raw string */
      }
    }
    return { name: String(fn["name"] ?? "function"), args, result: call["result"] };
  }
  for (const [key, value] of Object.entries(call)) {
    if (!key.endsWith("ToolCall") || !isRecord(value)) continue;
    const name = key.slice(0, -"ToolCall".length);
    const result = isRecord(value["result"]) ? value["result"] : value["result"];
    return { name, args: value["args"], result };
  }
  return { name: "tool", args: call, result: undefined };
}
