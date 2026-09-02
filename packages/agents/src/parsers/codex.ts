import type { AgentEvent } from "../types";
import { asArray, isRecord } from "./messages";

/**
 * Parser for `codex exec --json` JSONL: `thread.started`, `turn.started|completed|failed`,
 * `item.started|updated|completed` (agent_message, reasoning, command_execution, file_change,
 * mcp_tool_call, web_search, todo_list, error) and top-level `error`.
 */
export class CodexStreamParser {
  sessionId: string | undefined;
  /** Text already emitted per item id, so `item.updated` → `item.completed` only emits the suffix. */
  private readonly emittedText = new Map<string, string>();
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();

  feed(line: unknown): AgentEvent[] {
    if (!isRecord(line)) return [];
    const type = line["type"];
    if (typeof type !== "string") return [];
    if (type === "thread.started") {
      if (typeof line["thread_id"] === "string") this.sessionId = line["thread_id"];
      return [{ type: "init", ...(this.sessionId ? { sessionId: this.sessionId } : {}) }];
    }
    if (type === "turn.completed") {
      const usage = isRecord(line["usage"]) ? line["usage"] : undefined;
      if (!usage) return [];
      const input = num(usage["input_tokens"]);
      const output = num(usage["output_tokens"]);
      return [
        {
          type: "usage",
          ...(input !== undefined ? { inputTokens: input } : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
        },
      ];
    }
    if (type === "turn.failed") {
      return [{ type: "error", message: errorMessage(line["error"]) ?? "turn failed" }];
    }
    if (type === "error") {
      return [{ type: "error", message: errorMessage(line) ?? "codex error" }];
    }
    if (type.startsWith("item.")) {
      const item = line["item"];
      if (!isRecord(item)) return [];
      return this.onItem(type.slice("item.".length), item);
    }
    return [];
  }

  private onItem(phase: string, item: Record<string, unknown>): AgentEvent[] {
    const id =
      typeof item["id"] === "string"
        ? item["id"]
        : `item_${this.emittedText.size + this.startedTools.size}`;
    const kind = item["type"];
    switch (kind) {
      case "agent_message":
        return this.emitTextDelta(id, item["text"], "text");
      case "reasoning":
        return this.emitTextDelta(id, item["text"], "thinking");
      case "error":
        return [
          {
            type: "error",
            message: typeof item["message"] === "string" ? item["message"] : "codex error",
          },
        ];
      case "command_execution":
        return this.emitTool(
          phase,
          id,
          "command_execution",
          { command: item["command"] },
          item,
          () => ({
            output: {
              aggregated_output: item["aggregated_output"],
              exit_code: item["exit_code"],
              status: item["status"],
            },
            isError:
              (typeof item["exit_code"] === "number" && item["exit_code"] !== 0) ||
              item["status"] === "failed",
          }),
        );
      case "file_change":
        return this.emitTool(phase, id, "file_change", { changes: item["changes"] }, item, () => ({
          output: { changes: item["changes"], status: item["status"] },
          isError: item["status"] === "failed",
        }));
      case "mcp_tool_call": {
        const server = typeof item["server"] === "string" ? item["server"] : "mcp";
        const tool = typeof item["tool"] === "string" ? item["tool"] : "tool";
        return this.emitTool(phase, id, `mcp__${server}__${tool}`, item["arguments"], item, () => ({
          output:
            item["error"] !== undefined && item["error"] !== null ? item["error"] : item["result"],
          isError:
            item["status"] === "failed" || (item["error"] !== undefined && item["error"] !== null),
        }));
      }
      case "web_search":
        return this.emitTool(phase, id, "web_search", { query: item["query"] }, item, () => ({
          output: { query: item["query"], status: item["status"] },
          isError: item["status"] === "failed",
        }));
      default:
        return [];
    }
  }

  private emitTextDelta(id: string, text: unknown, type: "text" | "thinking"): AgentEvent[] {
    if (typeof text !== "string") return [];
    const previous = this.emittedText.get(id) ?? "";
    let delta: string;
    if (text.startsWith(previous)) delta = text.slice(previous.length);
    else delta = text; // model rewrote the message; emit it whole
    this.emittedText.set(id, text);
    return delta === "" ? [] : [{ type, delta }];
  }

  private emitTool(
    phase: string,
    id: string,
    name: string,
    input: unknown,
    item: Record<string, unknown>,
    result: () => { output: unknown; isError: boolean },
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!this.startedTools.has(id)) {
      this.startedTools.add(id);
      events.push({ type: "tool_use", id, name, input });
    }
    const status = item["status"];
    const finished =
      phase === "completed" ||
      status === "completed" ||
      status === "failed" ||
      status === "declined";
    if (finished && !this.completedTools.has(id)) {
      this.completedTools.add(id);
      const r = result();
      events.push({
        type: "tool_result",
        id,
        output: r.output,
        ...(r.isError ? { isError: true } : {}),
      });
    }
    return events;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function errorMessage(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!isRecord(v)) return undefined;
  if (typeof v["message"] === "string") return v["message"];
  const nested = v["error"];
  if (isRecord(nested) && typeof nested["message"] === "string") return nested["message"];
  const parts = asArray(v["errors"]).filter((e): e is string => typeof e === "string");
  return parts.length > 0 ? parts.join("; ") : undefined;
}
