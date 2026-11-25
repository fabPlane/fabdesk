import type { AgentId, ReasoningEffort } from "@fabdesk/protocol";

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
export type AgentRuntimeMode = "full" | "supervised";

/**
 * How a supervised run asks a human. The daemon implements it (pending requests, events, the
 * 30-minute timeout); an adapter that pauses in-band (Codex's app-server protocol, a fake adapter
 * in tests) awaits these. Claude Code does not use it: its permission prompts arrive at the
 * daemon's MCP `permission_prompt` tool instead.
 */
export interface AgentSupervisor {
  /** Resolves with the decision; `deny` after 30 minutes without one. */
  requestApproval(req: {
    tool: string;
    input: unknown;
    summary?: string;
  }): Promise<"approve" | "deny">;
  requestInput(req: { question: string; options?: string[]; signal?: AbortSignal }): Promise<string>;
}

export interface AgentAttachment {
  path: string;
  mime: string;
}

export interface AgentSession {
  /** Draft planning: no native writes or engineering tools, regardless of account permissions. */
  planningOnly?: boolean;
  cwd: string;
  prompt: string;
  attachments: AgentAttachment[];
  mcp: { url: string; token: string };
  resume?: string;
  model?: string;
  permission: AgentPermission;
  effort?: ReasoningEffort;
  /** `supervised` pauses writes for approval; adapters that cannot must not be started with it. */
  runtimeMode?: AgentRuntimeMode;
  supervisor?: AgentSupervisor;
  /** Approve one native prompt in harnesses with their own permission policy. */
  requestApproval?: AgentSupervisor["requestApproval"];
  /** Interactive questions are available independently of tool-approval supervision. */
  requestInput?: AgentSupervisor["requestInput"];
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
  models?: string[];
  modelAliases?: Record<string, string>;
  defaultModel?: string;
  modelEfforts?: Record<string, ReasoningEffort[]>;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  readonly installHint: string;
  /** `beta` adapters are shipped but unverified against a real CLI. */
  readonly beta?: boolean;
  /** Can pause a tool call until a human approves it (`runtimeMode: "supervised"`). */
  readonly supportsSupervised: boolean;
  detect(binaryPath?: string): Promise<DetectResult>;
  models(): string[];
  run(session: AgentSession): AgentRun;
}

/** Name of the MCP server as the agent sees it; tool names become `mcp__fabdesk__<tool>` / `fabdesk__<tool>`. */
export const MCP_SERVER_NAME = "fabdesk";
/** Environment variable that carries the MCP bearer token into the agent process (never argv). */
export const TOKEN_ENV = "FABDESK_TOKEN";
/** The daemon's MCP tool that Claude Code's `--permission-prompt-tool` blocks on in supervised mode. */
export const PERMISSION_PROMPT_TOOL = "permission_prompt";
