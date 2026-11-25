import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters } from "../index";
import type { AgentEvent, AgentSession } from "../types";
import { antigravityAdapter } from "./antigravity";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(env: Record<string, string> = {}): AgentSession {
  const cwd = mkdtempSync(join(tmpdir(), "agy-test-"));
  dirs.push(cwd);
  const script = join(cwd, "fake-agy.js");
  const bin = join(cwd, process.platform === "win32" ? "fake-agy.cmd" : "agy");
  writeFileSync(script, `
    const [mode, ...flags] = process.argv.slice(2);
    if (mode === "--version") { console.log("Antigravity CLI 1.5.16"); process.exit(0); }
    if (mode !== "acp" || !flags.includes("--sandbox") || !flags.includes("--process-per-session") ||
        flags.includes("--dangerously-skip-permissions") || process.env.FABDESK_TOKEN) process.exit(2);
    const readline = require("node:readline");
    const send = value => console.log(JSON.stringify({jsonrpc: "2.0", ...value}));
    const update = value => send({method: "session/update", params:{sessionId:"agy-thread", update:value}});
    let current;
    readline.createInterface({input: process.stdin}).on("line", line => {
      const { id, method, params, result } = JSON.parse(line);
      const ok = value => send({id, result:value});
      if (method === "initialize") ok({protocolVersion:1, agentCapabilities:{loadSession:true, mcpCapabilities:{http:!process.env.NO_HTTP}}});
      if (method === "session/new" || method === "session/load") {
        if (process.env.DENY_AUTH) return send({id,error:{code:-32000,message:"Authentication required",data:"do not display"}});
        if (require("node:fs").realpathSync(params.cwd) !== process.cwd() || params.mcpServers[0].headers[0].value !== "Bearer fixture-token") process.exit(3);
        if (method === "session/load") {
          if (params.sessionId !== "agy-thread") process.exit(4);
          update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"OLD"}});
        }
        ok({sessionId:"agy-thread",configOptions:[{id:"picked-model",category:"model"}]});
      }
      if (method === "session/set_config_option") {
        if(params.configId !== "picked-model" || params.value !== "chosen") process.exit(5);
        ok({});
      }
      if (method === "session/prompt") {
        if (!params.prompt[0].text.includes("Say hello")) process.exit(6);
        current = id;
        update({sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"Thinking"}});
        update({sessionUpdate:"tool_call",toolCallId:"t1",title:"Edit fake.txt",status:"pending"});
        send({id:"ask",method:"session/request_permission",params:{sessionId:"agy-thread",toolCall:{title:"Edit fake.txt",rawInput:{path:"fake.txt"}},options:[{kind:"allow_always",optionId:"always"},{kind:"allow_once",optionId:"once"},{kind:"reject_once",optionId:"no"}]}});
      }
      if (id === "ask") {
        const choice = result.outcome.optionId ?? result.outcome.outcome;
        update({sessionUpdate:"tool_call_update",toolCallId:"t1",status:"completed",rawOutput:choice});
        update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"hello"}});
        send({id:current,result:{stopReason:"end_turn"}});
      }
    });
  `);
  writeFileSync(bin, process.platform === "win32"
    ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { cwd, binaryPath: bin, prompt: "Say hello", attachments: [], permission: "acceptEdits", mcp: { url: "http://127.0.0.1:1/mcp", token: "fixture-token" }, env };
}

async function collect(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of antigravityAdapter.run(session).events) events.push(event);
  return events;
}

// Windows native batch shims aren't executable via Bun.spawn; installed Windows agy is an exe.
const nativeTest = process.platform === "win32" ? test.skip : test;

nativeTest("doctor discovers the new adapter and respects a binary override", async () => {
  const setup = fixture();
  expect(adapters.antigravity).toBe(antigravityAdapter);
  expect(await antigravityAdapter.detect(setup.binaryPath)).toMatchObject({ installed: true, version: "1.5.16" });
});

nativeTest("resumes, skips replay, selects a model, streams text, and waits for one-time approval", async () => {
  const session = fixture();
  const seen: unknown[] = [];
  const events = await collect({
    ...session, model: "chosen", resume: "agy-thread",
    requestApproval: async (req) => { seen.push(req); return "approve"; },
  });
  expect(seen).toEqual([{ tool: "Edit fake.txt", input: { path: "fake.txt" } }]);
  expect(events).toEqual([
    { type: "init", sessionId: "agy-thread", model: "chosen" },
    { type: "thinking", delta: "Thinking" },
    { type: "tool_use", id: "t1", name: "Edit fake.txt", input: {} },
    { type: "tool_result", id: "t1", output: "once", isError: false },
    { type: "text", delta: "hello" },
    { type: "done", exitCode: 0, sessionId: "agy-thread" },
  ]);
});

nativeTest("denies when no approval callback exists, even with bypass selected", async () => {
  const events = await collect({ ...fixture(), permission: "bypass" });
  expect(events).toContainEqual({ type:"tool_result", id:"t1", output:"cancelled", isError:false });
});

nativeTest("explains authentication or an incompatible CLI without forwarding raw diagnostics", async () => {
  const auth = await collect(fixture({ DENY_AUTH: "1" }));
  expect(auth).toEqual([
    { type:"error", message: expect.stringContaining("agy acp --login") },
    { type:"done", exitCode:1 },
  ]);
  const mcp = await collect(fixture({ NO_HTTP: "1" }));
  expect(mcp).toEqual([
    { type:"error", message: expect.stringContaining("HTTP MCP") },
    { type:"done", exitCode:1 },
  ]);
});

nativeTest("abort terminates a turn awaiting permission without granting it", async () => {
  const session = fixture();
  const run = antigravityAdapter.run({
    ...session,
    requestApproval: () => new Promise(() => {}),
  });
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === "tool_use") run.abort();
  }
  expect(events.at(-1)).toEqual({ type:"done", exitCode:130, sessionId:"agy-thread" });
  expect(events.some((event) => event.type === "tool_result")).toBe(false);
});
