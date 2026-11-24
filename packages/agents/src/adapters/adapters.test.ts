import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types";
import { claudeArgs, claudeMcpConfig, claudeEnv } from "./claude";
import { codexArgs, codexForeignServers, codexAdapter, codexEnv, CODEX_QUESTION_INSTRUCTIONS } from "./codex";
import { cursorArgs, cursorMcpPath, writeCursorMcp } from "./cursor";
import { grokArgs, grokConfigPath, writeGrokConfig, grokEnv } from "./grok";
import { agentEnv, applyImagePolicy, promptWithAttachments, replaceMarkedBlock } from "./shared";

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

test("effort reaches new and resumed Codex/Claude runs and Auto leaves CLI settings alone", () => {
  for (const resume of [undefined, "previous-session"]) {
    const input = session({ effort: "high", ...(resume ? { resume } : {}) });
    expect(codexArgs(input, "codex")).toContain('model_reasoning_effort="high"');
    const claude = claudeArgs(input, "claude");
    expect(claude[claude.indexOf("--effort") + 1]).toBe("high");
    expect(claude.indexOf("--effort")).toBeLessThan(claude.indexOf("--allowedTools"));
  }
  expect(codexArgs(session(), "codex").some(arg => arg.startsWith("model_reasoning_effort="))).toBe(false);
  expect(claudeArgs(session(), "claude")).not.toContain("--effort");
});

describe("shared", () => {
  test("agentEnv carries the token in FABDESK_TOKEN and session env overrides", () => {
    const env = agentEnv(session({ env: { FOO: "bar" } }));
    expect(env["FABDESK_TOKEN"]).toBe(TOKEN);
    expect(env["FOO"]).toBe("bar");
    expect(env["PATH"]).toBe(process.env["PATH"] ?? "");
  });

  test("promptWithAttachments mentions sketches, marked views and other files", () => {
    const p = promptWithAttachments("Go", [
      { path: "/a.png", mime: "image/png" },
      { path: "/m.png", mime: "image/png", role: "markup" },
      { path: "/notes.pdf", mime: "application/pdf" },
    ]);
    expect(p).toBe("Go\n\nSketch: /a.png\nMarked view: /m.png\nAttachment (application/pdf): /notes.pdf");
    expect(
      promptWithAttachments("Go", [{ path: "/a.png", mime: "image/png" }], { skipImages: true }),
    ).toBe("Go");
  });

  test("applyImagePolicy drops images and notes when the CLI cannot take them", () => {
    const markup = applyImagePolicy("none", "Make this thicker", [
      { path: "/m.png", mime: "image/png", role: "markup" },
      { path: "/notes.pdf", mime: "application/pdf" },
    ]);
    expect(markup.attachments).toEqual([{ path: "/notes.pdf", mime: "application/pdf" }]);
    expect(markup.prompt).toContain("does not accept images");
    expect(markup.prompt).toContain("markup text context");
    const kept = applyImagePolicy("read", "Go", [{ path: "/m.png", mime: "image/png", role: "markup" }]);
    expect(kept.attachments).toHaveLength(1);
    expect(kept.prompt).toBe("Go");
  });

  test("agentEnv respects platform casing when overriding inherited variables", () => {
    const env = agentEnv(session({ env: { Path: "custom-bin", fabdesk_token: "ignored" } }));
    if (process.platform === "win32") {
      expect(env["PATH"]).toBe("custom-bin");
      expect(env["Path"]).toBeUndefined();
      expect(env["fabdesk_token"]).toBeUndefined();
    } else {
      expect(env["Path"]).toBe("custom-bin");
      expect(env["PATH"]).toBe(process.env["PATH"] ?? "");
      expect(env["fabdesk_token"]).toBe("ignored");
    }
    expect(env["FABDESK_TOKEN"]).toBe(TOKEN);
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
      "Design a blinky\n\nSketch: /p/sketches/a.png",
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
      timeout: 1_830_000,
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
  test("desktop CLIs with daemon support use a separate server on new and resumed turns", () => {
    for (const resume of [undefined, "existing-thread"]) {
      const args = codexArgs(session(resume ? { resume } : {}), "codex", [], true);
      expect(args.slice(0, 3)).toEqual(["codex", "--no-daemon", "exec"]);
      expect(args).toContain('mcp_servers.fabdesk.url="http://127.0.0.1:4321/mcp?profile=native"');
    }
    expect(codexArgs(session(), "codex")).not.toContain("--no-daemon");
  });
  test("new and resumed chats route questions to fabPlane instead of the CLI's text-only question fallback", () => {
    for (const resume of [undefined, "existing-thread"]) {
      const args = codexArgs(session(resume ? { resume } : {}), "codex");
      const override = args.find((arg) => arg.startsWith("developer_instructions="));
      expect(override).toBeDefined();
      expect((Bun.TOML.parse(override!) as { developer_instructions: string }).developer_instructions).toBe(CODEX_QUESTION_INSTRUCTIONS);
      expect(override).toContain("mcp__fabdesk__request_user_input");
      expect(override).toContain("request_user_input_async");
    }
  });
  test("new thread: exec with sandbox, cwd, mcp overrides, image flag", () => {
    const args = codexArgs(session({ model: "gpt-5.5" }), "codex");
    expect(args.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--approve-for-me");
    expect(args[args.indexOf("-C") + 1]).toBe(dir);
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('mcp_servers.fabdesk.url="http://127.0.0.1:4321/mcp?profile=native"');
    expect(args).toContain('mcp_servers.fabdesk.bearer_token_env_var="FABDESK_TOKEN"');
    expect(args).toContain("mcp_servers.fabdesk.tool_timeout_sec=1830");
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

  test("preserves an explicitly selected substrate profile", () => {
    const args = codexArgs(
      session({ mcp: { url: "http://127.0.0.1:4321/mcp?profile=substrate", token: TOKEN } }),
      "codex",
    );
    expect(args).toContain('mcp_servers.fabdesk.url="http://127.0.0.1:4321/mcp?profile=substrate"');
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
      "Design a blinky\n\nSketch: /p/sketches/a.png",
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

describe("MCP isolation", () => {
  test("Codex disables apps, plugins, and every foreign name on new turns and resume", () => {
    const inventory = JSON.stringify([
      { name: "user.with.dots", transport: { type: "stdio" } },
      { name: "fabdesk", transport: { type: "streamable_http" } },
      { name: 'quoted"name', transport: { type: "streamable_http" } },
    ]);
    const foreign = codexForeignServers(inventory);
    expect(foreign).toEqual(["user.with.dots", 'quoted"name']);
    for (const resume of [undefined, "old-thread"]) {
      const args = codexArgs(session(resume ? { resume } : {}), "codex", foreign);
      expect(args).toContain("features.apps=false");
      expect(args).toContain("features.plugins=false");
      expect(args).toContain("features.remote_plugin=false");
      const table = args.find((arg) => arg.startsWith("mcp_servers={"))!;
      const overrides = (
        Bun.TOML.parse(table) as { mcp_servers: Record<string, { enabled: boolean }> }
      ).mcp_servers;
      expect(overrides["user.with.dots"]?.enabled).toBe(false);
      expect(overrides['quoted"name']?.enabled).toBe(false);
      expect(args).toContain("mcp_servers.fabdesk.enabled=true");
    }
  });

  test("Codex refuses missing or malformed inventories and conflicting reserved transport", () => {
    for (const raw of [
      "broken",
      "{}",
      '[{"name":"x"}]',
      '[{"name":"fabdesk","transport":{"type":"stdio"}}]',
    ])
      expect(() => codexForeignServers(raw)).toThrow();
    expect(() =>
      codexAdapter.run(
        session({
          binaryPath: join(dir, "missing-cli"),
          env: { CODEX_HOME: join(dir, "empty-codex") },
        }),
      ),
    ).toThrow();
  });

  test("Codex isolates preferences, shares live auth, and keeps trust writes private", () => {
    const source = join(dir, "global-codex");
    mkdirSync(source);
    const config =
      '[model_providers.custom]\nbase_url="https://example.test"\n[mcp_servers.foreign]\ncommand="foreign"\n[plugins.fixture]\nenabled=true\n[profiles.custom.mcp_servers.hidden]\ncommand="hidden"\n';
    writeFileSync(join(source, "config.toml"), config);
    writeFileSync(join(source, "auth.json"), '{"test":"credential"}');
    const env = codexEnv(session({ env: { CODEX_HOME: source } }));
    const isolated = env["CODEX_HOME"]!;
    expect(isolated).not.toBe(source);
    const child = readFileSync(join(isolated, "config.toml"), "utf8");
    expect(child).not.toContain("mcp_servers");
    expect(child).not.toContain("plugins");
    expect(child).toContain("https://example.test");
    writeFileSync(join(isolated, "config.toml"), "# simulated CLI trust write");
    expect(readFileSync(join(source, "config.toml"), "utf8")).toBe(config);
    expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"test":"credential"}');
    expect(readFileSync(join(isolated, "auth.json"), "utf8")).toBe('{"test":"credential"}');
    expect(lstatSync(join(isolated, "auth.json")).isSymbolicLink()).toBe(true);
    const other = codexEnv(session({ cwd: join(dir, "other"), env: { CODEX_HOME: source } }));
    // Match Codex's real file-backend refresh write (truncate in place).
    writeFileSync(join(isolated, "auth.json"), '{"test":"rotated"}');
    expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"test":"rotated"}');
    expect(readFileSync(join(other["CODEX_HOME"]!, "auth.json"), "utf8")).toBe(
      '{"test":"rotated"}',
    );
    // A standalone re-login replacing the source file remains visible to both projects.
    writeFileSync(join(source, "replacement.json"), '{"test":"standalone-login"}');
    renameSync(join(source, "replacement.json"), join(source, "auth.json"));
    expect(readFileSync(join(isolated, "auth.json"), "utf8")).toBe('{"test":"standalone-login"}');
    expect(codexEnv(session({ env: { CODEX_HOME: source } }))["CODEX_HOME"]).toBe(isolated);
  });

  test("Claude forces account connectors off even if session env enables them", () => {
    const env = claudeEnv(session({ env: { ENABLE_CLAUDEAI_MCP_SERVERS: "true" } }));
    expect(env["ENABLE_CLAUDEAI_MCP_SERVERS"]).toBe("false");
    expect(env["FABDESK_TOKEN"]).toBe(TOKEN);
    expect(claudeArgs(session(), "claude")).toContain("--strict-mcp-config");
  });

  test("Grok scopes policy per project, preserves global config/auth and shares resume storage", () => {
    const source = join(dir, "global-grok");
    mkdirSync(source);
    const config = '[mcp_servers.foreign]\ncommand="foreign"\n[ui]\nscreen_mode="minimal"\n';
    writeFileSync(join(source, "config.toml"), config);
    writeFileSync(join(source, "auth.json"), '{"test":"credential"}');
    const env = grokEnv(session({ env: { GROK_HOME: source } }));
    const isolated = env["GROK_HOME"]!;
    expect(isolated).not.toBe(source);
    expect(readFileSync(join(source, "config.toml"), "utf8")).toBe(config);
    expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"test":"credential"}');
    expect(env["GROK_AUTH_PATH"]).toBe(join(source, "auth.json"));
    expect(existsSync(join(isolated, "auth.json"))).toBe(false);
    expect(readFileSync(join(isolated, "requirements.toml"), "utf8")).toContain(
      'server_url = "http://127.0.0.1:4321/mcp"',
    );
    expect(readFileSync(join(isolated, "managed_config.toml"), "utf8")).toContain(
      'server_name = "fabdesk"',
    );
    writeFileSync(join(source, "sessions", "resume-marker"), "prior session");
    expect(readFileSync(join(isolated, "sessions", "resume-marker"), "utf8")).toBe("prior session");
    const other = grokEnv(session({ cwd: join(dir, "other"), env: { GROK_HOME: source } }));
    expect(other["GROK_HOME"]).not.toBe(isolated);
    expect(other["GROK_AUTH_PATH"]).toBe(env["GROK_AUTH_PATH"]!);
    // Match Grok's atomic credential replacement: every child and standalone reader
    // uses the same file and adjacent native auth.json.lock, with no write-back race.
    writeFileSync(join(source, "replacement.json"), '{"test":"rotated"}');
    renameSync(join(source, "replacement.json"), env["GROK_AUTH_PATH"]!);
    expect(readFileSync(other["GROK_AUTH_PATH"]!, "utf8")).toBe('{"test":"rotated"}');
    expect(env["FABDESK_TOKEN"]).toBe(TOKEN);
    for (const vendor of ["CLAUDE", "CURSOR", "CODEX"]) {
      expect(env[`GROK_${vendor}_MCPS_ENABLED`]).toBe("false");
      expect(env[`GROK_${vendor}_PLUGINS_ENABLED`]).toBe("false");
    }
    const childConfig = readFileSync(join(isolated, "config.toml"), "utf8");
    expect(childConfig).not.toContain(TOKEN);
    expect(childConfig).not.toContain("foreign");
    expect(childConfig).toContain('screen_mode = "minimal"');
  });

  test("Grok preserves an explicit shared auth path outside GROK_HOME", () => {
    const auth = join(dir, "login", "auth.json");
    const env = grokEnv(session({ env: { GROK_HOME: join(dir, "grok"), GROK_AUTH_PATH: auth } }));
    expect(env["GROK_AUTH_PATH"]).toBe(auth);
    expect(existsSync(auth)).toBe(false);
  });

  test("Grok preserves and rejects an earlier private refresh-token snapshot", () => {
    const source = join(dir, "grok");
    const request = session({ env: { GROK_HOME: source } });
    const env = grokEnv(request);
    writeFileSync(join(source, "auth.json"), "source token");
    const snapshot = join(env["GROK_HOME"]!, "auth.json");
    writeFileSync(snapshot, "possibly rotated token");
    expect(() => grokEnv(request)).toThrow("private snapshot");
    expect(readFileSync(join(source, "auth.json"), "utf8")).toBe("source token");
    expect(readFileSync(snapshot, "utf8")).toBe("possibly rotated token");
  });
});

test("draft planning cannot inherit bypass or extra native write tools", () => {
  const s = session({ planningOnly: true, permission: "bypass", extraAllowedTools: ["Bash", "Write"], resume: "draft-session" });
  const codex = codexArgs(s, "codex", ["foreign"]);
  expect(codex).toContain('sandbox_mode="read-only"');
  expect(codex).toContain('approval_policy="never"');
  expect(codex).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(codex).not.toContain("--approve-for-me");
  expect(codex).toContain('mcp_servers.fabdesk.enabled_tools=["request_project_creation","request_user_input"]');
  const claude = claudeArgs(s, "claude");
  expect(claude[claude.indexOf("--tools") + 1]).toBe("Read");
  expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("default");
  expect(claude).not.toContain("Bash");
  expect(claude).not.toContain("Write");
  expect(claude).not.toContain("bypassPermissions");
});

test("Codex project history starts private and imports only an explicitly resumed legacy rollout", () => {
  const source = join(dir,"codex-history");
  mkdirSync(join(source,"sessions/2026/11/17"),{recursive:true});
  writeFileSync(join(source,"sessions/2026/11/17/rollout-known-id.jsonl"),"known thread");
  writeFileSync(join(source,"sessions/2026/11/17/rollout-other-id.jsonl"),"unrelated thread");
  const fresh = codexEnv(session({env:{CODEX_HOME:source}}));
  expect(existsSync(join(fresh.CODEX_HOME!,"sessions/2026/11/17/rollout-other-id.jsonl"))).toBe(false);
  const resumed = codexEnv(session({resume:"known-id",env:{CODEX_HOME:source}}));
  expect(readFileSync(join(resumed.CODEX_HOME!,"sessions/2026/11/17/rollout-known-id.jsonl"),"utf8")).toBe("known thread");
  expect(existsSync(join(resumed.CODEX_HOME!,"sessions/2026/11/17/rollout-other-id.jsonl"))).toBe(false);
  expect(readFileSync(join(source,"sessions/2026/11/17/rollout-other-id.jsonl"),"utf8")).toBe("unrelated thread");
});

test("Codex history migration preserves rejection of a legacy private auth snapshot",async()=>{
 const {createHash}=await import("node:crypto"),source=join(dir,"legacy-codex"),legacy=join(source,"fabdesk-agents",createHash("sha256").update(dir).digest("hex"));
 mkdirSync(legacy,{recursive:true});writeFileSync(join(source,"auth.json"),"original auth");writeFileSync(join(legacy,"auth.json"),"possibly refreshed private auth");
 expect(()=>codexEnv(session({env:{CODEX_HOME:source}}))).toThrow("private snapshot");expect(readFileSync(join(legacy,"auth.json"),"utf8")).toBe("possibly refreshed private auth");
});
