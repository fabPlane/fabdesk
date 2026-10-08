import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectBinary, resolveFirst } from "../detect";
import { CodexStreamParser } from "../parsers/codex";
import { runAgentProcess } from "../process";
import type { AgentAdapter, AgentRun, AgentSession } from "../types";
import { MCP_SERVER_NAME, TOKEN_ENV } from "../types";
import { linkSharedAuth } from "./shared-auth";
import {
  agentEnv,
  isImage,
  promptWithAttachments,
  readFileIfExists,
  tomlString,
  writeFileEnsuringDir,
} from "./shared";

const CANDIDATES = ["codex", "~/.local/bin/codex"];

/**
 * `codex exec` (new thread) or `codex exec resume <thread_id>` (follow-up). The resume subcommand
 * has no `-C`/`--sandbox` flags, so the working directory comes from the spawn cwd and the sandbox
 * from a `-c sandbox_mode=…` override, which both forms accept.
 */
const ISOLATION_CONFIG = [
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.remote_plugin=false",
];

/** Parse the CLI's effective inventory, including project config, without contacting servers. */
export function codexForeignServers(json: string): string[] {
  const entries: unknown = JSON.parse(json);
  if (!Array.isArray(entries)) throw new Error("Codex MCP isolation: invalid inventory");
  return entries
    .map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("name" in entry) ||
        typeof entry.name !== "string" ||
        !("transport" in entry)
      )
        throw new Error("Codex MCP isolation: invalid server entry");
      if (entry.name === MCP_SERVER_NAME) {
        const transport = entry.transport;
        if (
          typeof transport !== "object" ||
          transport === null ||
          !("type" in transport) ||
          transport.type !== "streamable_http"
        )
          throw new Error("Codex MCP isolation: reserved fabdesk server must use HTTP");
      }
      return entry.name;
    })
    .filter((name) => name !== MCP_SERVER_NAME);
}

export function codexArgs(
  session: AgentSession,
  bin: string,
  foreignServers: string[] = [],
): string[] {
  const args = [bin, "exec"];
  // This is an `exec` option rather than an `exec resume` option, so it must precede the
  // subcommand. Keeping it here also lets follow-up messages use approval-requiring MCP tools.
  if (session.permission !== "bypass") args.push("--approve-for-me");
  if (session.resume) args.push("resume", session.resume);
  args.push("--json", "--skip-git-repo-check", ...ISOLATION_CONFIG);
  // A whole-table -c override merges with user config (0.160), so disable each
  // foreign entry explicitly. Keys must be inside the TOML value: Codex's dotted
  // override-path parser treats quote characters literally (0.160).
  if (foreignServers.length)
    args.push(
      "-c",
      `mcp_servers={${foreignServers
        .map((name) => `${tomlString(name)}={enabled=false}`)
        .join(",")}}`,
    );
  if (session.permission === "bypass") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    // `codex exec` is non-interactive, so approval-requiring MCP tools otherwise fail with
    // "approval policy is never". Let Codex review those requests automatically while keeping
    // shell commands and approved tool calls inside the workspace-write sandbox.
    args.push("-c", 'sandbox_mode="workspace-write"');
  }
  if (!session.resume) args.push("-C", session.cwd);
  if (session.model) args.push("-m", session.model);
  args.push(
    "-c",
    // Codex snapshots MCP tools at turn start and does not currently apply
    // tools/list_changed, so request the complete inventory up front.
    `mcp_servers.${MCP_SERVER_NAME}.url=${tomlString(withNativeProfile(session.mcp.url))}`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.enabled=true`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=${tomlString(TOKEN_ENV)}`,
  );
  for (const a of session.attachments) if (isImage(a)) args.push("-i", a.path);
  // Prompts commonly start with Markdown list markers (`- ...`). Without the option terminator,
  // Codex parses such prompts as CLI flags and exits with code 2 before emitting JSONL.
  args.push("--", promptWithAttachments(session.prompt, session.attachments, { skipImages: true }));
  return args;
}

function withNativeProfile(url: string): string {
  const endpoint = new URL(url);
  if (!endpoint.searchParams.has("profile")) endpoint.searchParams.set("profile", "native");
  return endpoint.toString();
}

/**
 * Child-only config home: Codex exec can persist project trust even with -c overrides.
 * Never let that touch the user's config. Persist the overlay for follow-up thread IDs.
 * Exception: Windows EPERM uses the live home with a run warning, retaining credentials
 * safely while giving up per-project config isolation.
 */
export function codexEnv(
  session: AgentSession,
  onWarning?: (message: string) => void,
): Record<string, string> {
  const env = agentEnv(session);
  const source = resolve(
    session.cwd,
    env["CODEX_HOME"] ?? join(env["HOME"] ?? env["USERPROFILE"] ?? homedir(), ".codex"),
  );
  const id = createHash("sha256").update(session.cwd).digest("hex");
  const isolated = join(source, "fabdesk-agents", id);
  mkdirSync(isolated, { recursive: true, mode: 0o700 });
  const raw = readFileIfExists(join(source, "config.toml"));
  const config = raw === undefined ? {} : (Bun.TOML.parse(raw) as Record<string, unknown>);
  const stripMcp = (table: Record<string, unknown>) => {
    for (const key of ["mcp_servers", "plugins", "marketplaces"]) delete table[key];
    for (const value of Object.values(table))
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        stripMcp(value as Record<string, unknown>);
  };
  stripMcp(config);
  // Bun 1.4 runtime API, not yet declared by the pinned @types/bun 1.2.
  const toml = Bun.TOML as typeof Bun.TOML & { stringify(value: Record<string, unknown>): string };
  writeFileEnsuringDir(join(isolated, "config.toml"), toml.stringify(config), 0o600);
  try {
    linkSharedAuth(join(isolated, "auth.json"), join(source, "auth.json"));
    // Preserve ordinary user skills/instructions and existing conversation paths. Plugin
    // skills stay excluded. New state databases and trust writes stay inside the overlay.
    for (const name of ["sessions", "archived_sessions", "skills", "rules", "AGENTS.md"]) {
      const original = join(source, name);
      if (existsSync(original) && !existsSync(join(isolated, name)))
        symlinkSync(
          original,
          join(isolated, name),
          statSync(original).isDirectory()
            ? process.platform === "win32"
              ? "junction"
              : "dir"
            : "file",
        );
    }
  } catch (error) {
    // Windows file symlinks require a privilege ordinary accounts may not have.
    // Never substitute a credential copy or hard link: either can strand refreshes.
    // Snapshot/store validation errors still block launch on every platform.
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
      throw error;
    env["CODEX_HOME"] = source;
    onWarning?.(
      "Windows denied a Codex overlay symlink (EPERM). Using the original CODEX_HOME and live credential store; per-project config isolation is unavailable. Apps and plugins remain disabled and discovered foreign MCP servers are disabled, but full MCP isolation is not qualified. Codex may save config and state in the original home.",
    );
    return env;
  }
  env["CODEX_HOME"] = isolated;
  return env;
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  installHint:
    "Install Codex: npm install -g @openai/codex (or brew install codex), then run `codex login`.",
  detect: (binaryPath) => detectBinary(CANDIDATES, binaryPath),
  models: () => [
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ],
  /**
   * `codex exec --json` (0.150) has no approval channel: the exec subcommand has no
   * `--ask-for-approval`, and with `approval_policy="on-request"` it runs writes without emitting
   * any approval item. Supervising Codex needs the app-server JSON-RPC client
   * (`item/commandExecution/requestApproval`, `item/permissions/requestApproval`,
   * `item/tool/requestUserInput`), which this adapter does not speak yet.
   */
  supportsSupervised: false,
  run(session: AgentSession): AgentRun {
    const parser = new CodexStreamParser();
    const bin = session.binaryPath ?? resolveFirst(CANDIDATES) ?? "codex";
    let isolationWarning: string | undefined;
    const env = codexEnv(session, (warning) => {
      isolationWarning = warning;
    });
    const inventory = Bun.spawnSync([bin, "mcp", "list", "--json", ...ISOLATION_CONFIG], {
      cwd: session.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    // Never fall back to an unisolated launch when the CLI cannot enumerate its config.
    if (inventory.exitCode !== 0) throw new Error("Codex MCP isolation: inventory command failed");
    const foreignServers = codexForeignServers(inventory.stdout.toString());
    const run = runAgentProcess({
      cmd: codexArgs(session, bin, foreignServers),
      cwd: session.cwd,
      env,
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
    if (!isolationWarning) return run;
    const warning = isolationWarning;
    return {
      ...run,
      events: (async function* () {
        // A nonfatal warning belongs in the persisted run reply, not an error event
        // (the core treats an error event as a failed run even if the CLI succeeds).
        yield { type: "text" as const, delta: `⚠ ${warning}\n\n` };
        yield* run.events;
      })(),
    };
  },
};
