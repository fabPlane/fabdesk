import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types";
import { codexAdapter, codexEnv } from "./codex";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let dir: string;
let denied: ReturnType<typeof spyOn<typeof fs, "symlinkSync">>;

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "fabdesk-codex-windows-"));
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  denied = spyOn(fs, "symlinkSync").mockImplementation(() => {
    throw Object.assign(new Error("symlink privilege denied"), { code: "EPERM" });
  });
});
afterEach(() => {
  denied.mockRestore();
  Object.defineProperty(process, "platform", originalPlatform);
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(resume?: string): AgentSession {
  return {
    cwd: dir,
    prompt: "Hello",
    attachments: [],
    mcp: { url: "http://127.0.0.1:4321/mcp", token: "fixture-token" },
    permission: "acceptEdits",
    env: { CODEX_HOME: join(dir, "source"), W1_CAPTURE: join(dir, "capture.jsonl") },
    ...(resume ? { resume } : {}),
  };
}

function seed(): string {
  const source = join(dir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, "auth.json"), "fixture credentials");
  fs.writeFileSync(join(source, "config.toml"), '[mcp_servers.foreign]\ncommand="foreign"\n');
  return source;
}

test("Windows EPERM uses the live home without a credential snapshot and warns", () => {
  const source = seed();
  const warnings: string[] = [];
  const env = codexEnv(session(), (message) => warnings.push(message));
  expect(denied).toHaveBeenCalled();
  expect(env["CODEX_HOME"]).toBe(source);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("per-project config isolation is unavailable");
  expect(env["FABDESK_TOKEN"]).toBe("fixture-token");
  const overlays = fs.readdirSync(join(source, "fabdesk-agents"));
  expect(overlays).toHaveLength(1);
  expect(fs.existsSync(join(source, "fabdesk-agents", overlays[0]!, "auth.json"))).toBe(false);
  // A standalone source-side atomic replacement stays visible to the launch/resume home.
  fs.writeFileSync(join(source, "replacement.json"), "rotated fixture credentials");
  fs.renameSync(join(source, "replacement.json"), join(source, "auth.json"));
  expect(fs.readFileSync(join(env["CODEX_HOME"]!, "auth.json"), "utf8")).toBe(
    "rotated fixture credentials",
  );
  expect(codexEnv(session("prior-thread"))["CODEX_HOME"]).toBe(source);
  expect(fs.readFileSync(join(source, "config.toml"), "utf8")).toContain("mcp_servers.foreign");
});

test("child Codex does not inherit a desktop chat's routing identity", () => {
  seed();
  const s = session();
  s.env = { ...s.env, CODEX_APP_TOOLS_PIPE_PATH: "parent-pipe", CODEX_THREAD_ID: "parent", CODEX_SESSION_ID: "parent-session", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "desktop", CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: "parent-identity" };
  const env = codexEnv(s);
  for (const key of ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY"]) expect(env[key]).toBeUndefined();
  expect(env.FABDESK_TOKEN).toBe("fixture-token");
  expect(env.CODEX_HOME).toBe(join(dir, "source"));
});

test("Linux and macOS still propagate EPERM instead of falling back", () => {
  seed();
  for (const platform of ["linux", "darwin"]) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    expect(() => codexEnv(session())).toThrow("symlink privilege denied");
  }
});

test("successful links keep the existing live overlay on Linux, macOS and privileged Windows", () => {
  denied.mockRestore();
  const source = seed();
  for (const platform of ["linux", "darwin", "win32"]) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    const warnings: string[] = [];
    const env = codexEnv(session(), (message) => warnings.push(message));
    expect(env["CODEX_HOME"]).not.toBe(source);
    expect(warnings).toHaveLength(0);
    expect(fs.lstatSync(join(env["CODEX_HOME"]!, "auth.json")).isSymbolicLink()).toBe(true);
    fs.writeFileSync(join(source, "replacement.json"), `fixture credentials on ${platform}`);
    fs.renameSync(join(source, "replacement.json"), join(source, "auth.json"));
    expect(fs.readFileSync(join(env["CODEX_HOME"]!, "auth.json"), "utf8")).toBe(
      `fixture credentials on ${platform}`,
    );
  }
});

test("Windows preserves snapshot rejection and does not hide unrelated filesystem failures", () => {
  const source = seed();
  codexEnv(session());
  const overlay = join(
    source,
    "fabdesk-agents",
    "v2",
    createHash("sha256").update(dir).digest("hex"),
  );
  fs.writeFileSync(join(overlay, "auth.json"), "possibly newer fixture credentials");
  expect(() => codexEnv(session())).toThrow("private snapshot");
  expect(fs.readFileSync(join(overlay, "auth.json"), "utf8")).toBe(
    "possibly newer fixture credentials",
  );
  fs.rmSync(join(overlay, "auth.json"));
  denied.mockImplementation(() => {
    throw Object.assign(new Error("unrelated access denial"), { code: "EACCES" });
  });
  expect(() => codexEnv(session())).toThrow("unrelated access denial");
});

test("Windows fallback logs a nonfatal warning on initial and resumed runs and retains MCP restrictions", async () => {
  const source = seed();
  const cli = join(dir, "fixture-cli");
  // This runs on the actual Linux host; only the adapter's platform and symlink result are simulated.
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--help") process.exit(0);
fs.appendFileSync(process.env.W1_CAPTURE, JSON.stringify({args,home:process.env.CODEX_HOME})+"\\n");
if (args[0] === "mcp") console.log(JSON.stringify([{name:"foreign",transport:{type:"stdio"}}]));
else {
  console.log(JSON.stringify({type:"thread.started",thread_id:"fixture-session"}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
}
`,
    { mode: 0o755 },
  );
  for (const resume of [undefined, "fixture-session"]) {
    const run = codexAdapter.run({ ...session(resume), binaryPath: cli });
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events[0]).toMatchObject({ type: "text" });
    expect((events[0] as { delta: string }).delta).toContain("⚠ Windows denied");
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      exitCode: 0,
      sessionId: "fixture-session",
    });
  }
  const launches = fs
    .readFileSync(join(dir, "capture.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; home: string });
  expect(launches).toHaveLength(4);
  for (const launch of launches) {
    expect(launch.home).toBe(source);
    for (const setting of [
      "features.apps=false",
      "features.plugins=false",
      "features.remote_plugin=false",
    ])
      expect(launch.args).toContain(setting);
    if (launch.args[0] === "exec")
      expect(launch.args).toContain('mcp_servers={"foreign"={enabled=false}}');
  }
  expect(launches[3]!.args).toContain("resume");
});
