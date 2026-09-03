import { detectBinary } from "../detect";
import { MessagesStreamParser } from "../parsers/messages";
import { runAgentProcess } from "../process";
import type { AgentAdapter, AgentPermission, AgentRun, AgentSession } from "../types";
import { MCP_SERVER_NAME, TOKEN_ENV } from "../types";
import { agentEnv, promptWithAttachments } from "./shared";

const CANDIDATES = ["claude", "~/.local/bin/claude", "~/.claude/local/claude"];
const BUILTIN_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];

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
      },
    },
  });
}

export function claudeArgs(session: AgentSession, bin: string): string[] {
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
    permissionMode(session.permission),
  ];
  if (session.resume) args.push("--resume", session.resume);
  if (session.model) args.push("--model", session.model);
  // Variadic: keep last so it cannot swallow the prompt.
  args.push(
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}__*`,
    ...BUILTIN_TOOLS,
    ...(session.extraAllowedTools ?? []),
  );
  return args;
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude",
  installHint:
    "Install Claude Code: https://code.claude.com/docs/en/setup (curl -fsSL https://claude.ai/install.sh | bash), then run `claude` once to sign in.",
  detect: (binaryPath) => detectBinary(CANDIDATES, binaryPath),
  models: () => ["fable", "opus", "sonnet", "haiku"],
  run(session: AgentSession): AgentRun {
    const parser = new MessagesStreamParser();
    return runAgentProcess({
      cmd: claudeArgs(session, session.binaryPath ?? "claude"),
      cwd: session.cwd,
      env: agentEnv(session),
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
  },
};
