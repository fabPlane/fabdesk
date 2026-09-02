import type { AgentEvent } from "../types";

/**
 * Parser for the Anthropic Messages `stream-json` wire format as emitted by
 * `claude -p --output-format stream-json --verbose --include-partial-messages` and by
 * `grok -p --output-format streaming-messages-json --include-partial-messages`.
 *
 * Text and thinking are emitted from `stream_event` deltas when present and from the whole
 * `assistant` message otherwise; a message whose deltas were already streamed is not re-emitted.
 * Tool calls are always taken from the complete `assistant` message (deltas only carry partial JSON).
 */
export class MessagesStreamParser {
  sessionId: string | undefined;
  private currentMessageId: string | undefined;
  private readonly streamedText = new Set<string>();
  private readonly streamedThinking = new Set<string>();
  private readonly emittedTools = new Set<string>();
  private readonly emittedResults = new Set<string>();

  feed(line: unknown): AgentEvent[] {
    if (!isRecord(line)) return [];
    switch (line["type"]) {
      case "system":
        return this.onSystem(line);
      case "stream_event":
        return this.onStreamEvent(line);
      case "assistant":
        return this.onAssistant(line);
      case "user":
        return this.onUser(line);
      case "result":
        return this.onResult(line);
      default:
        return [];
    }
  }

  private onSystem(line: Record<string, unknown>): AgentEvent[] {
    if (line["subtype"] !== "init") return [];
    const events: AgentEvent[] = [];
    if (typeof line["session_id"] === "string") this.sessionId = line["session_id"];
    const mcpServers = asArray(line["mcp_servers"])
      .filter(isRecord)
      .map((s) => ({ name: String(s["name"] ?? ""), status: String(s["status"] ?? "unknown") }));
    events.push({
      type: "init",
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(typeof line["model"] === "string" ? { model: line["model"] } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    });
    for (const err of asArray(line["mcp_server_errors"]).filter(isRecord)) {
      events.push({
        type: "error",
        message:
          `MCP server "${String(err["name"] ?? "?")}" skipped (${String(err["type"] ?? "invalid_config")}): ${String(err["message"] ?? "")}`.trim(),
      });
    }
    for (const server of mcpServers) {
      if (server.status === "failed") {
        events.push({ type: "error", message: `MCP server "${server.name}" failed to connect` });
      }
    }
    return events;
  }

  private onStreamEvent(line: Record<string, unknown>): AgentEvent[] {
    const ev = line["event"];
    if (!isRecord(ev)) return [];
    if (ev["type"] === "message_start") {
      const msg = ev["message"];
      this.currentMessageId =
        isRecord(msg) && typeof msg["id"] === "string" ? msg["id"] : undefined;
      return [];
    }
    if (ev["type"] !== "content_block_delta") return [];
    const delta = ev["delta"];
    if (!isRecord(delta)) return [];
    const id = this.currentMessageId;
    if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
      if (id) this.streamedText.add(id);
      return delta["text"] === "" ? [] : [{ type: "text", delta: delta["text"] }];
    }
    if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
      if (id) this.streamedThinking.add(id);
      return delta["thinking"] === "" ? [] : [{ type: "thinking", delta: delta["thinking"] }];
    }
    return [];
  }

  private onAssistant(line: Record<string, unknown>): AgentEvent[] {
    const msg = line["message"];
    if (!isRecord(msg)) return [];
    const id = typeof msg["id"] === "string" ? msg["id"] : undefined;
    const events: AgentEvent[] = [];
    for (const block of asArray(msg["content"]).filter(isRecord)) {
      switch (block["type"]) {
        case "text": {
          const text = block["text"];
          if (typeof text === "string" && text !== "" && !(id && this.streamedText.has(id))) {
            events.push({ type: "text", delta: text });
          }
          break;
        }
        case "thinking": {
          const thinking = block["thinking"];
          if (
            typeof thinking === "string" &&
            thinking !== "" &&
            !(id && this.streamedThinking.has(id))
          ) {
            events.push({ type: "thinking", delta: thinking });
          }
          break;
        }
        case "tool_use": {
          const toolId = typeof block["id"] === "string" ? block["id"] : undefined;
          if (!toolId || this.emittedTools.has(toolId)) break;
          this.emittedTools.add(toolId);
          events.push({
            type: "tool_use",
            id: toolId,
            name: String(block["name"] ?? ""),
            input: block["input"],
          });
          break;
        }
        default:
          break;
      }
    }
    return events;
  }

  private onUser(line: Record<string, unknown>): AgentEvent[] {
    const msg = line["message"];
    if (!isRecord(msg)) return [];
    const events: AgentEvent[] = [];
    for (const block of asArray(msg["content"]).filter(isRecord)) {
      if (block["type"] !== "tool_result") continue;
      const toolId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : undefined;
      if (!toolId || this.emittedResults.has(toolId)) continue;
      this.emittedResults.add(toolId);
      events.push({
        type: "tool_result",
        id: toolId,
        output: flattenContent(block["content"]),
        ...(block["is_error"] === true ? { isError: true } : {}),
      });
    }
    return events;
  }

  private onResult(line: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (typeof line["session_id"] === "string") this.sessionId = line["session_id"];
    const usage = isRecord(line["usage"]) ? line["usage"] : undefined;
    const inputTokens = usage
      ? sumNumbers(
          usage["input_tokens"],
          usage["cache_read_input_tokens"],
          usage["cache_creation_input_tokens"],
        )
      : undefined;
    const outputTokens = usage ? sumNumbers(usage["output_tokens"]) : undefined;
    const cost = typeof line["total_cost_usd"] === "number" ? line["total_cost_usd"] : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined || cost !== undefined) {
      events.push({
        type: "usage",
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      });
    }
    if (line["is_error"] === true) {
      const errors = asArray(line["errors"]).filter((e): e is string => typeof e === "string");
      const message =
        errors.length > 0
          ? errors.join("; ")
          : typeof line["result"] === "string" && line["result"] !== ""
            ? line["result"]
            : `agent finished with ${String(line["subtype"] ?? "error")}`;
      events.push({ type: "error", message });
    }
    return events;
  }
}

/** Tool-result content is either a string or a list of content blocks; text-only lists collapse to a string. */
export function flattenContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((c) => isRecord(c) && c["type"] === "text" && typeof c["text"] === "string")
  ) {
    return content.map((c) => (c as Record<string, string>)["text"]).join("\n");
  }
  return content;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function sumNumbers(...values: unknown[]): number | undefined {
  let total: number | undefined;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) total = (total ?? 0) + v;
  }
  return total;
}
