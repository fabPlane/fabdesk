import type { AgentId } from "@fabdesk/protocol";

/** Normalised stream of what an agent CLI is doing; every adapter maps its own wire format onto this. */
export type AgentEvent =
  | {
      type: "init";
      sessionId?: string;
      model?: string;
      mcpServers?: Array<{ name: string; status: string }>;
    }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; isError?: boolean }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "error"; message: string }
  | { type: "done"; sessionId?: string; exitCode: number };

export type AgentPermission = "acceptEdits" | "auto" | "bypass";

export interface AgentAttachment {
  path: string;
  mime: string;
}

export interface AgentSession {
  cwd: string;
  prompt: string;
  attachments: AgentAttachment[];
  mcp: { url: string; token: string };
  resume?: string;
  model?: string;
  permission: AgentPermission;
  extraAllowedTools?: string[];
  binaryPath?: string;
  env?: Record<string, string>;
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  abort(): void;
  pid?: number;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly installHint: string;
  /** `beta` adapters are shipped but unverified against a real CLI. */
  readonly beta?: boolean;
  detect(binaryPath?: string): Promise<DetectResult>;
  models(): string[];
  run(session: AgentSession): AgentRun;
}

/** Name of the MCP server as the agent sees it; tool names become `mcp__fabdesk__<tool>` / `fabdesk__<tool>`. */
export const MCP_SERVER_NAME = "fabdesk";
/** Environment variable that carries the MCP bearer token into the agent process (never argv). */
export const TOKEN_ENV = "FABDESK_TOKEN";
