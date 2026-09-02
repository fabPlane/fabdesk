import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBinary } from "./detect";
import { detectAgents } from "./index";

let dir: string;
let originalPath: string | undefined;

function fakeBinary(name: string, versionLine: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${versionLine}"\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fabdesk-detect-"));
  originalPath = process.env["PATH"];
  process.env["PATH"] = dir;
});

afterEach(() => {
  process.env["PATH"] = originalPath ?? "";
  rmSync(dir, { recursive: true, force: true });
});

describe("detectBinary", () => {
  test("finds the first candidate on PATH and parses its version", async () => {
    const path = fakeBinary("claude", "9.9.9 (Claude Code)");
    const result = await detectBinary(["claude", "~/.local/bin/claude"]);
    expect(result).toEqual({ installed: true, version: "9.9.9", path });
  });

  test("falls back to later candidates and to explicit paths", async () => {
    const path = fakeBinary("cursor-agent", "cursor-agent version 2026.1.5");
    expect(await detectBinary(["agent", "cursor-agent"])).toEqual({
      installed: true,
      version: "2026.1.5",
      path,
    });
    expect(await detectBinary(["agent", join(dir, "cursor-agent")])).toEqual({
      installed: true,
      version: "2026.1.5",
      path,
    });
  });

  test("reports not installed when nothing matches", async () => {
    expect(await detectBinary(["agent", "cursor-agent", join(dir, "missing")])).toEqual({
      installed: false,
    });
  });

  test("an explicit binaryPath is the only thing checked", async () => {
    fakeBinary("claude", "1.0.0");
    const custom = fakeBinary("my-claude", "2.0.0");
    expect(await detectBinary(["claude"], custom)).toEqual({
      installed: true,
      version: "2.0.0",
      path: custom,
    });
    expect(await detectBinary(["claude"], join(dir, "nope"))).toEqual({ installed: false });
  });

  test("a binary whose --version fails is still installed", async () => {
    const path = join(dir, "codex");
    writeFileSync(path, "#!/bin/sh\nexit 3\n");
    chmodSync(path, 0o755);
    expect(await detectBinary(["codex"])).toEqual({ installed: true, path });
  });
});

describe("detectAgents", () => {
  test("returns one AgentInfo per adapter with install hints and settings overrides", async () => {
    const grokPath = fakeBinary("grok", "grok 1.0.13 (abc) [stable]");
    const custom = fakeBinary("codex-custom", "codex-cli 0.145.0");
    const infos = await detectAgents({
      kicadCliPath: null,
      ngspicePath: null,
      router: "capacity",
      defaultAgent: "claude",
      agents: {
        codex: {
          binaryPath: custom,
          model: null,
          permissionMode: "acceptEdits",
          extraAllowedTools: [],
        },
      },
      keepCoreRunning: false,
      webmcpWriteTools: false,
      theme: "system",
    });
    expect(infos.map((i) => i.id)).toEqual(["claude", "codex", "grok", "cursor"]);
    const byId = Object.fromEntries(infos.map((i) => [i.id, i]));
    // claude/cursor also probe fixed home paths (~/.local/bin/…), so only PATH-independent facts are asserted.
    expect(byId["claude"]).toMatchObject({ displayName: "Claude Code" });
    expect(typeof byId["claude"]?.installed).toBe("boolean");
    expect(byId["claude"]?.installHint).toContain("claude");
    expect(byId["codex"]).toMatchObject({ installed: true, version: "0.145.0", path: custom });
    expect(byId["grok"]).toMatchObject({ installed: true, version: "1.0.13", path: grokPath });
    expect(byId["cursor"]).toMatchObject({ displayName: "Cursor Agent (beta)" });
    for (const info of infos) expect(info.models.length).toBeGreaterThan(0);
  });
});
