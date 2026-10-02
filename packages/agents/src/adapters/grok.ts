import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectBinary, resolveFirst } from "../detect";
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

// Runtime is Bun 1.4; the repo still pins @types/bun 1.2, before TOML.stringify.
const toml = Bun.TOML as typeof Bun.TOML & {
  stringify(value: Record<string, unknown>): string;
};

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

/**
 * GROK_HOME is supported; native requirements bind MCP from every config/plugin source.
 * Keep a project-specific overlay so concurrent projects cannot race their allowlists.
 * Original global configs are only read. Share session storage to preserve resume IDs.
 */
export function grokEnv(session: AgentSession): Record<string, string> {
  const env = agentEnv(session);
  const source = resolve(
    session.cwd,
    env["GROK_HOME"] ?? join(env["HOME"] ?? env["USERPROFILE"] ?? homedir(), ".grok"),
  );
  const id = createHash("sha256").update(session.cwd).digest("hex");
  const isolated = join(source, "fabdesk-agents", id);
  mkdirSync(isolated, { recursive: true, mode: 0o700 });
  const config = readFileIfExists(join(source, "config.toml"));
  // Preserve non-MCP preferences and permission rules. The native allowlist below
  // restricts user, project, imported and plugin-provided MCP, not built-in tools.
  const preferences: Record<string, unknown> =
    config === undefined ? {} : (Bun.TOML.parse(config) as Record<string, unknown>);
  delete preferences["mcp_servers"];
  delete preferences["plugins"];
  writeFileEnsuringDir(join(isolated, "config.toml"), toml.stringify(preferences), 0o600);
  // Native auth-path override keeps both credentials and Grok's adjacent refresh lock
  // in the original home. Config isolation must not split the live credential store.
  if (existsSync(join(isolated, "auth.json")))
    throw new Error(
      "Grok credential overlay contains a private snapshot instead of the shared store",
    );
  env["GROK_AUTH_PATH"] = resolve(session.cwd, env["GROK_AUTH_PATH"] ?? join(source, "auth.json"));
  const sessions = join(source, "sessions");
  mkdirSync(sessions, { recursive: true });
  if (!existsSync(join(isolated, "sessions")))
    symlinkSync(
      sessions,
      join(isolated, "sessions"),
      process.platform === "win32" ? "junction" : "dir",
    );
  // Match endpoint rather than name: imported/plugin aliases must not gain authority
  // merely by naming themselves fabdesk. Native requirements are enforced by 1.0.46.
  const policy = (file: string, allow: Record<string, string>) => {
    const raw = readFileIfExists(join(source, file));
    const settings: Record<string, unknown> =
      raw === undefined ? {} : (Bun.TOML.parse(raw) as Record<string, unknown>);
    // Preserve non-MCP managed preferences and built-in permission rules.
    delete settings["allowedMcpServers"];
    settings["allowed_mcp_servers"] = [allow];
    writeFileEnsuringDir(join(isolated, file), toml.stringify(settings), 0o600);
  };
  policy("managed_config.toml", { server_name: MCP_SERVER_NAME });
  policy("requirements.toml", { server_url: session.mcp.url });
  env["GROK_HOME"] = isolated;
  // Grok imports other CLIs' MCP and plugins by default. Disable those MCP sources
  // before startup, rather than reporting intentional policy exclusions as failures.
  for (const vendor of ["CLAUDE", "CURSOR", "CODEX"]) {
    env[`GROK_${vendor}_MCPS_ENABLED`] = "false";
    env[`GROK_${vendor}_PLUGINS_ENABLED`] = "false";
  }
  return env;
}

export const grokAdapter: AgentAdapter = {
  id: "grok",
  displayName: "Grok",
  installHint:
    "Install Grok Build (grok CLI) from https://grok.com/build, then run `grok login`. Expected at ~/.grok/bin/grok.",
  detect: (binaryPath) => detectBinary(CANDIDATES, binaryPath),
  models: () => ["grok-4.6", "grok-4.5"],
  /** No approval channel in `grok` headless output. */
  supportsSupervised: false,
  run(session: AgentSession): AgentRun {
    const parser = new MessagesStreamParser();
    writeGrokConfig(session.cwd, session.mcp.url);
    return runAgentProcess({
      cmd: grokArgs(session, session.binaryPath ?? resolveFirst(CANDIDATES) ?? "grok"),
      cwd: session.cwd,
      env: grokEnv(session),
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
  },
};
