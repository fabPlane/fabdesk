import { detectBinary, resolveFirst } from "../detect";
import { MessagesStreamParser } from "../parsers/messages";
import { runAgentProcess } from "../process";
import type { AgentAdapter, AgentPermission, AgentRun, AgentSession } from "../types";
import { MCP_SERVER_NAME, PERMISSION_PROMPT_TOOL, TOKEN_ENV } from "../types";
import { agentEnv, promptWithAttachments } from "./shared";

const CANDIDATES = ["claude", "~/.local/bin/claude", "~/.claude/local/claude"];
const BUILTIN_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
/** Supervised: only reads are pre-allowed; every other call reaches the daemon's prompt tool. */
const SUPERVISED_BUILTIN_TOOLS = ["Read", "Glob", "Grep"];

function permissionMode(p: AgentPermission): string {
  switch (p) {
    case "acceptEdits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "bypass":
      return "bypassPermissions";
  }
}

/**
 * `--mcp-config` accepts an inline JSON string; `${VAR}` in `headers` is expanded by Claude Code
 * from the process environment, so the token never touches argv or disk.
 */
export function claudeMcpConfig(url: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url,
        headers: { Authorization: `Bearer \${${TOKEN_ENV}}` },
        // A route can legitimately run for its whole timeoutMs (up to 10 min); Claude Code's default
        // idle abort is ~5 min. The daemon also heartbeats progress, this is the belt to those braces.
        timeout: 1_200_000,
      },
    },
  });
}

/**
 * Supervised runs use Claude Code's permission-prompt hook (`--permission-prompt-tool`, hidden
 * from `--help` but live in 2.1.x, print mode only): every call the permission mode would ask a
 * person about is sent to the named MCP tool as `{ tool_name, input, tool_use_id }`, and the
 * tool answers with one text block holding `{"behavior":"allow","updatedInput":…}` or
 * `{"behavior":"deny","message":…}`. The daemon serves that tool and classifies the call, so the
 * allow list here only pre-approves reads; `manual` is the mode that asks about everything else
 * (Claude Code maps it to its internal `default`). Verified live against 2.1.252: a Bash `touch`
 * reaches the daemon and runs only after approval, a deny comes back as a tool error the model
 * carries on from, and `AskUserQuestion` arrives the same way. Note that Claude auto-allows
 * commands it deems read-only (`echo`, `ls`, …) in that mode without ever asking.
 */
export function claudeArgs(session: AgentSession, bin: string): string[] {
  const supervised = session.runtimeMode === "supervised";
  const args = [
    bin,
    "-p",
    promptWithAttachments(session.prompt, session.attachments),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    claudeMcpConfig(session.mcp.url),
    "--strict-mcp-config",
    "--permission-mode",
    supervised ? "manual" : permissionMode(session.permission),
  ];
  if (supervised) {
    args.push("--permission-prompt-tool", `mcp__${MCP_SERVER_NAME}__${PERMISSION_PROMPT_TOOL}`);
  }
  if (session.resume) args.push("--resume", session.resume);
  if (session.model) args.push("--model", session.model);
  // Variadic: keep last so it cannot swallow the prompt. Supervised runs do not pre-allow the
  // fabdesk tools: the daemon decides per call (reads pass straight through). The user's own
  // extra allow rules still apply — they opted into those explicitly.
  args.push(
    "--allowedTools",
    ...(supervised ? SUPERVISED_BUILTIN_TOOLS : [`mcp__${MCP_SERVER_NAME}__*`, ...BUILTIN_TOOLS]),
    ...(session.extraAllowedTools ?? []),
  );
  return args;
}

/** Account connectors are independent of local strict MCP config. Override session env too. */
export function claudeEnv(session: AgentSession): Record<string, string> {
  return { ...agentEnv(session), ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude",
  installHint:
    "Install Claude Code: https://code.claude.com/docs/en/setup (curl -fsSL https://claude.ai/install.sh | bash), then run `claude` once to sign in.",
  detect: (binaryPath) => detectBinary(CANDIDATES, binaryPath),
  models: () => ["fable", "opus", "sonnet", "haiku"],
  supportsSupervised: true,
  run(session: AgentSession): AgentRun {
    const parser = new MessagesStreamParser();
    return runAgentProcess({
      cmd: claudeArgs(session, session.binaryPath ?? resolveFirst(CANDIDATES) ?? "claude"),
      cwd: session.cwd,
      env: claudeEnv(session),
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
  },
};
