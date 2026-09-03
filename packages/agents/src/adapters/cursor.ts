import { join } from "node:path";
import { detectBinary } from "../detect";
import { CursorStreamParser } from "../parsers/cursor";
import { runAgentProcess } from "../process";
import type { AgentAdapter, AgentRun, AgentSession } from "../types";
import { MCP_SERVER_NAME, TOKEN_ENV } from "../types";
import { agentEnv, promptWithAttachments, readFileIfExists, writeFileEnsuringDir } from "./shared";

const CANDIDATES = ["agent", "cursor-agent", "~/.local/bin/agent", "~/.local/bin/cursor-agent"];

export function cursorMcpPath(cwd: string): string {
  return join(cwd, ".cursor", "mcp.json");
}

/** Merges the fabdesk server into `<cwd>/.cursor/mcp.json`; Cursor expands `${env:VAR}` in headers. */
export function writeCursorMcp(cwd: string, url: string): string {
  const path = cursorMcpPath(cwd);
  let existing: Record<string, unknown> = {};
  const raw = readFileIfExists(path);
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        existing = parsed as Record<string, unknown>;
    } catch {
      /* unreadable config is replaced */
    }
  }
  const servers =
    typeof existing["mcpServers"] === "object" && existing["mcpServers"] !== null
      ? (existing["mcpServers"] as Record<string, unknown>)
      : {};
  servers[MCP_SERVER_NAME] = { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } };
  existing["mcpServers"] = servers;
  writeFileEnsuringDir(path, `${JSON.stringify(existing, null, 2)}\n`);
  return path;
}

export function cursorArgs(session: AgentSession, bin: string): string[] {
  const args = [
    bin,
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--force",
    "--trust",
    "--approve-mcps",
    "--workspace",
    session.cwd,
  ];
  if (session.model) args.push("--model", session.model);
  // No resume in v1: the CLI's `--resume [chatId]` is documented but its stream-json ids are unverified.
  args.push(promptWithAttachments(session.prompt, session.attachments));
  return args;
}

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  beta: true,
  installHint:
    "Install the Cursor CLI: curl https://cursor.com/install -fsS | bash, then run `agent login`.",
  detect: (binaryPath) => detectBinary(CANDIDATES, binaryPath),
  models: () => ["auto", "sonnet-4.5", "opus-4.5", "gpt-5"],
  run(session: AgentSession): AgentRun {
    const parser = new CursorStreamParser();
    writeCursorMcp(session.cwd, session.mcp.url);
    return runAgentProcess({
      cmd: cursorArgs(session, session.binaryPath ?? "agent"),
      cwd: session.cwd,
      env: agentEnv(session),
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
  },
};
