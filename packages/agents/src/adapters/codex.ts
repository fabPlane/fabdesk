import { detectBinary, resolveFirst } from "../detect";
import { CodexStreamParser } from "../parsers/codex";
import { runAgentProcess } from "../process";
import type { AgentAdapter, AgentRun, AgentSession } from "../types";
import { MCP_SERVER_NAME, TOKEN_ENV } from "../types";
import { agentEnv, isImage, promptWithAttachments, tomlString } from "./shared";

const CANDIDATES = ["codex", "~/.local/bin/codex"];

/**
 * `codex exec` (new thread) or `codex exec resume <thread_id>` (follow-up). The resume subcommand
 * has no `-C`/`--sandbox` flags, so the working directory comes from the spawn cwd and the sandbox
 * from a `-c sandbox_mode=…` override, which both forms accept.
 */
export function codexArgs(session: AgentSession, bin: string): string[] {
  const args = [bin, "exec"];
  // This is an `exec` option rather than an `exec resume` option, so it must precede the
  // subcommand. Keeping it here also lets follow-up messages use approval-requiring MCP tools.
  if (session.permission !== "bypass") args.push("--approve-for-me");
  if (session.resume) args.push("resume", session.resume);
  args.push("--json", "--skip-git-repo-check");
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
    `mcp_servers.${MCP_SERVER_NAME}.url=${tomlString(withAllToolsets(session.mcp.url))}`,
    "-c",
    `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=${tomlString(TOKEN_ENV)}`,
  );
  for (const a of session.attachments) if (isImage(a)) args.push("-i", a.path);
  // Prompts commonly start with Markdown list markers (`- ...`). Without the option terminator,
  // Codex parses such prompts as CLI flags and exits with code 2 before emitting JSONL.
  args.push("--", promptWithAttachments(session.prompt, session.attachments, { skipImages: true }));
  return args;
}

function withAllToolsets(url: string): string {
  const endpoint = new URL(url);
  endpoint.searchParams.set("toolsets", "all");
  return endpoint.toString();
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
    return runAgentProcess({
      cmd: codexArgs(session, session.binaryPath ?? resolveFirst(CANDIDATES) ?? "codex"),
      cwd: session.cwd,
      env: agentEnv(session),
      parse: (line) => parser.feed(line),
      sessionId: () => parser.sessionId,
    });
  },
};
