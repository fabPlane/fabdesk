import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types";
import { claudeArgs, claudeMcpConfig } from "./claude";
import { codexArgs } from "./codex";
import { cursorArgs, cursorMcpPath, writeCursorMcp } from "./cursor";
import { grokArgs, grokConfigPath, writeGrokConfig } from "./grok";
import { agentEnv, promptWithAttachments, replaceMarkedBlock } from "./shared";

const TOKEN = "super-secret-token";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fabdesk-adapters-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    cwd: dir,
    prompt: "Design a blinky",
    attachments: [{ path: "/p/sketches/a.png", mime: "image/png" }],
    mcp: { url: "http://127.0.0.1:4321/mcp", token: TOKEN },
    permission: "acceptEdits",
    ...overrides,
  };
}

describe("shared", () => {
  test("agentEnv carries the token in FABDESK_TOKEN and session env overrides", () => {
    const env = agentEnv(session({ env: { FOO: "bar" } }));
    expect(env["FABDESK_TOKEN"]).toBe(TOKEN);
    expect(env["FOO"]).toBe("bar");
    expect(env["PATH"]).toBe(process.env["PATH"] ?? "");
  });

  test("promptWithAttachments mentions sketches and other files", () => {
    const p = promptWithAttachments("Go", [
      { path: "/a.png", mime: "image/png" },
      { path: "/notes.pdf", mime: "application/pdf" },
    ]);
    expect(p).toBe(
      "Go\n\nSketch: /a.png — read it with the Read tool.\nAttachment (application/pdf): /notes.pdf",
    );
    expect(
      promptWithAttachments("Go", [{ path: "/a.png", mime: "image/png" }], { skipImages: true }),
    ).toBe("Go");
  });

  test("replaceMarkedBlock replaces in place and appends otherwise", () => {
    const first = replaceMarkedBlock("[user]\nname = 'x'\n", "# s", "# e", "a = 1");
    expect(first).toBe("[user]\nname = 'x'\n\n# s\na = 1\n# e\n");
    const second = replaceMarkedBlock(`${first}\n[tail]\nz = 2\n`, "# s", "# e", "a = 2");
    expect(second).toBe("[user]\nname = 'x'\n\n# s\na = 2\n# e\n\n[tail]\nz = 2\n");
    expect(replaceMarkedBlock(undefined, "# s", "# e", "a = 1")).toBe("# s\na = 1\n# e\n");
  });
});

describe("claude adapter", () => {
  test("builds the documented command line without leaking the token", () => {
    const args = claudeArgs(
      session({ resume: "sess-1", model: "opus", extraAllowedTools: ["Bash(git *)"] }),
      "claude",
    );
    expect(args.slice(0, 3)).toEqual([
      "claude",
      "-p",
      "Design a blinky\n\nSketch: /p/sketches/a.png — read it with the Read tool.",
    ]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--include-partial-messages");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args.slice(args.indexOf("--allowedTools"))).toEqual([
      "--allowedTools",
      "mcp__fabdesk__*",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Bash(git *)",
    ]);
    expect(args.join(" ")).not.toContain(TOKEN);
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1] as string) as {
      mcpServers: {
        fabdesk: { type: string; url: string; headers: Record<string, string>; timeout: number };
      };
    };
    expect(cfg.mcpServers.fabdesk).toEqual({
      type: "http",
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer ${FABDESK_TOKEN}" },
      // Longer than Claude Code's ~5 min idle abort: a route may run its whole timeoutMs.
      timeout: 1_200_000,
    });
  });

  test("maps permission modes", () => {
    expect(claudeArgs(session({ permission: "bypass" }), "claude")).toContain("bypassPermissions");
    expect(claudeArgs(session({ permission: "auto" }), "claude")).toContain("auto");
    expect(claudeMcpConfig("http://x/mcp")).not.toContain(TOKEN);
  });

  test("supervised: manual mode, the daemon's prompt tool, and only reads pre-allowed", () => {
    const args = claudeArgs(
      session({
        runtimeMode: "supervised",
        permission: "bypass",
        extraAllowedTools: ["Bash(git status)"],
      }),
      "claude",
    );
    // The permission mode from Settings is ignored: bypass would skip the prompt tool entirely.
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "manual"]);
    expect(args.slice(args.indexOf("--permission-prompt-tool"))).toEqual([
      "--permission-prompt-tool",
      "mcp__fabdesk__permission_prompt",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "Bash(git status)",
    ]);
    expect(args).not.toContain("mcp__fabdesk__*");
    expect(args).not.toContain("Write");
    // Full mode is unchanged.
    expect(claudeArgs(session(), "claude")).not.toContain("--permission-prompt-tool");
  });
});

describe("codex adapter", () => {
  test("new thread: exec with sandbox, cwd, mcp overrides, image flag", () => {
    const args = codexArgs(session({ model: "gpt-5.5" }), "codex");
    expect(args.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--approve-for-me");
    expect(args[args.indexOf("-C") + 1]).toBe(dir);
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('mcp_servers.fabdesk.url="http://127.0.0.1:4321/mcp"');
    expect(args).toContain('mcp_servers.fabdesk.bearer_token_env_var="FABDESK_TOKEN"');
    expect(args[args.indexOf("-i") + 1]).toBe("/p/sketches/a.png");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("Design a blinky");
    expect(args.join(" ")).not.toContain(TOKEN);
  });

  test("terminates options before a prompt that starts with a hyphen", () => {
    const args = codexArgs(session({ prompt: "- Improve this PCB" }), "codex");
    expect(args.slice(-2)).toEqual(["--", "- Improve this PCB"]);
  });

  test("resume: `exec resume <thread>` without -C, bypass replaces the sandbox", () => {
    const args = codexArgs(session({ resume: "thread-9", permission: "bypass" }), "codex");
    expect(args.slice(0, 4)).toEqual(["codex", "exec", "resume", "thread-9"]);
    expect(args).not.toContain("-C");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--approve-for-me");
    expect(args).not.toContain('sandbox_mode="workspace-write"');
  });

  test("auto-reviews approvals in both sandboxed permission modes", () => {
    expect(codexArgs(session({ permission: "acceptEdits" }), "codex")).toContain(
      "--approve-for-me",
    );
    expect(codexArgs(session({ permission: "auto" }), "codex")).toContain("--approve-for-me");
  });

  test("puts automatic approval before the resume subcommand", () => {
    const args = codexArgs(session({ resume: "thread-9", permission: "acceptEdits" }), "codex");
    expect(args.slice(0, 5)).toEqual(["codex", "exec", "--approve-for-me", "resume", "thread-9"]);
  });
});

describe("grok adapter", () => {
  test("writes .grok/config.toml with an env-referencing header and keeps user content", () => {
    const path = grokConfigPath(dir);
    expect(path).toBe(join(dir, ".grok", "config.toml"));
    writeGrokConfig(dir, "http://127.0.0.1:4321/mcp");
    const first = readFileSync(path, "utf8");
    expect(first).toContain("[mcp_servers.fabdesk]");
    expect(first).toContain('url = "http://127.0.0.1:4321/mcp"');
    expect(first).toContain('Authorization = "Bearer ${FABDESK_TOKEN}"');
    expect(first).not.toContain(TOKEN);

    writeFileSync(path, `[ui]\nscreen_mode = "minimal"\n\n${first}`);
    writeGrokConfig(dir, "http://127.0.0.1:9999/mcp");
    const second = readFileSync(path, "utf8");
    expect(second.startsWith('[ui]\nscreen_mode = "minimal"\n')).toBe(true);
    expect(second).toContain('url = "http://127.0.0.1:9999/mcp"');
    expect(second).not.toContain("4321");
    expect(second.match(/\[mcp_servers\.fabdesk\]/g)).toHaveLength(1);
  });

  test("command line", () => {
    const args = grokArgs(
      session({ resume: "s-2", model: "grok-4.6", extraAllowedTools: ["Bash(ls *)"] }),
      "grok",
    );
    expect(args.slice(0, 3)).toEqual([
      "grok",
      "-p",
      "Design a blinky\n\nSketch: /p/sketches/a.png — read it with the Read tool.",
    ]);
    expect(args[args.indexOf("--cwd") + 1]).toBe(dir);
    expect(args).toContain("--trust");
    expect(args[args.indexOf("--output-format") + 1]).toBe("streaming-messages-json");
    expect(args).toContain("--include-partial-messages");
    const allows = args.filter((_, i) => args[i - 1] === "--allow");
    expect(allows).toEqual([
      "MCPTool(fabdesk__*)",
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "Bash(ls *)",
    ]);
    expect(args[args.indexOf("--resume") + 1]).toBe("s-2");
    expect(args[args.indexOf("-m") + 1]).toBe("grok-4.6");
    expect(grokArgs(session({ permission: "bypass" }), "grok")).toContain("bypassPermissions");
  });
});

describe("cursor adapter", () => {
  test("merges fabdesk into .cursor/mcp.json and uses ${env:FABDESK_TOKEN}", () => {
    const path = cursorMcpPath(dir);
    expect(path).toBe(join(dir, ".cursor", "mcp.json"));
    writeCursorMcp(dir, "http://127.0.0.1:4321/mcp");
    const first = JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(first.mcpServers["fabdesk"]).toEqual({
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer ${env:FABDESK_TOKEN}" },
    });

    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { other: { command: "x" }, fabdesk: { url: "old" } },
        extra: 1,
      }),
    );
    writeCursorMcp(dir, "http://127.0.0.1:5555/mcp");
    const second = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
      extra: number;
    };
    expect(second.extra).toBe(1);
    expect(second.mcpServers["other"]).toEqual({ command: "x" });
    expect(second.mcpServers["fabdesk"]?.["url"]).toBe("http://127.0.0.1:5555/mcp");
    expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
  });

  test("command line has print + stream-json + force and the prompt last", () => {
    const args = cursorArgs(session({ model: "auto", resume: "ignored" }), "agent");
    expect(args.slice(0, 4)).toEqual(["agent", "-p", "--output-format", "stream-json"]);
    expect(args).toContain("--force");
    expect(args[args.indexOf("--workspace") + 1]).toBe(dir);
    expect(args[args.indexOf("--model") + 1]).toBe("auto");
    expect(args).not.toContain("--resume");
    expect(args.at(-1)).toContain("Design a blinky");
  });
});
