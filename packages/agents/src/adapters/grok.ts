import { join } from "node:path";
import { detectBinary } from "../detect";
import { MessagesStreamParser } from "../parsers/messages";
import { runAgentProcess } from "../process";
import type { AgentAdapter, AgentPermission, AgentRun, AgentSession } from "../types";
import { MCP_SERVER_NAME, TOKEN_ENV } from "../types";
import {
  agentEnv,
  promptWithAttachments,
  readFileIfExists,
  replaceMarkedBlock,
  tomlString,
  writeFileEnsuringDir,
} from "./shared";

const CANDIDATES = ["grok", "~/.grok/bin/grok"];
const START = "# fabdesk:mcp-start (generated per run; do not edit)";
const END = "# fabdesk:mcp-end";
/** Grok's rule names: `Edit` also covers `write`, `Grep` also covers `list_dir`/glob. */
const ALLOW_RULES = [`MCPTool(${MCP_SERVER_NAME}__*)`, "Read", "Edit", "Write", "Grep", "Glob"];

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

/** `[mcp_servers.<name>]` block; grok expands `${VAR}` in `headers` from the process environment. */
export function grokMcpToml(url: string): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = ${tomlString(url)}`,
    "enabled = true",
    "",
    `[mcp_servers.${MCP_SERVER_NAME}.headers]`,
    `Authorization = "Bearer \${${TOKEN_ENV}}"`,
  ].join("\n");
}

export function grokConfigPath(cwd: string): string {
  return join(cwd, ".grok", "config.toml");
}

/** Writes/refreshes the generated block in `<cwd>/.grok/config.toml`, preserving other content. */
export function writeGrokConfig(cwd: string, url: string): string {
  const path = grokConfigPath(cwd);
  writeFileEnsuringDir(
    path,
    replaceMarkedBlock(readFileIfExists(path), START, END, grokMcpToml(url)),
  );
  return path;
}

export function grokArgs(session: AgentSession, bin: string): string[] {
  const args = [
    bin,
    "-p",
    promptWithAttachments(session.prompt, session.attachments),
    "--cwd",
    session.cwd,
    // Repo-local `.grok/config.toml` MCP servers only start for trusted folders; fabdesk owns the project dir.
    "--trust",
    "--output-format",
    "streaming-messages-json",
    "--include-partial-messages",
    "--permission-mode",
    permissionMode(session.permission),
  ];
  for (const rule of [...ALLOW_RULES, ...(session.extraAllowedTools ?? [])])
    args.push("--allow", rule);
  if (session.resume) args.push("--resume", session.resume);
  if (session.model) args.push("-m", session.model);
  return args;
}

export const grokAdapter: AgentAdapter = {
  id: "grok",
  displayName: "Grok Build",
  installHint:
    "Install Grok Build (grok CLI) from https://grok.com/build, then run `grok login`. Expected at ~/.grok/bin/grok.",
  detect: (binaryPath) => detectBinary(CANDIDATES, binaryPath),
  models: () => ["grok-4.6", "grok-4.5"],
  run(session: AgentSession): AgentRun {
    const parser = new MessagesStreamParser();
    writeGrokConfig(session.cwd, session.mcp.url);
    return runAgentProcess({
      cmd: grokArgs(session, session.binaryPath ?? "grok"),
      cwd: session.cwd,
      env: agentEnv(session),
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
  },
};
