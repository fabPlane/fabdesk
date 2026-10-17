import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBinary } from "./detect";
import { detectAgents } from "./index";

let dir: string;
let originalPath: string | undefined;

function fakeBinary(name: string): string {
  // Reuse the trusted runtime bytes: unsigned compiled fixtures are blocked by
  // Windows Smart App Control, and POSIX shell scripts cannot run on Windows.
  const path = join(dir, process.platform === "win32" ? `${name}.exe` : name);
  copyFileSync(process.execPath, path);
  return path;
}
const versionArgs = (line: string) => ["-e", `console.log(${JSON.stringify(line)})`];

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
    const path = fakeBinary("claude");
    const result = await detectBinary(
      ["claude", "~/.local/bin/claude"], undefined, versionArgs("9.9.9 (Claude Code)"),
    );
    expect(result).toEqual({ installed: true, version: "9.9.9", path });
  });

  test("falls back to later candidates and to explicit paths", async () => {
    const path = fakeBinary("cursor-agent");
    const args = versionArgs("cursor-agent version 2026.1.5");
    expect(await detectBinary(["agent", "cursor-agent"], undefined, args)).toEqual({
      installed: true,
      version: "2026.1.5",
      path,
    });
    expect(await detectBinary(["agent", path], undefined, args)).toEqual({
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
    fakeBinary("claude");
    const custom = fakeBinary("my-claude");
    expect(await detectBinary(["claude"], custom, versionArgs("2.0.0"))).toEqual({
      installed: true,
      version: "2.0.0",
      path: custom,
    });
    expect(await detectBinary(["claude"], join(dir, "nope"))).toEqual({ installed: false });
  });

  test("a binary whose version probe fails is still installed", async () => {
    const path = fakeBinary("codex");
    expect(await detectBinary(["codex"], undefined, ["-e", "process.exit(3)"])).toEqual({
      installed: true, path,
    });
  });
});

describe("detectAgents", () => {
  test("returns one AgentInfo per adapter with install hints and settings overrides", async () => {
    const grokPath = fakeBinary("grok");
    const custom = fakeBinary("codex-custom");
    const infos = await detectAgents({
      kicadCliPath: null,
      ngspicePath: null,
      fpPcbBridgeUrl: null,
      router: "fab_router",
      tracemakerManifestUrl: null,
      defaultAgent: "claude",
      defaultRuntimeMode: "full",
      agents: {
        codex: {
          binaryPath: custom,
          model: null,
          permissionMode: "acceptEdits",
          extraAllowedTools: [],
          pickerModels: [],
        },
      },
      keepCoreRunning: false,
      webmcpWriteTools: false,
      errorReporting: true,
      usageArchiveConsent: false,
      usageArchiveChoiceComplete: false,
      theme: "system",
      remote: { enabled: false, host: "0.0.0.0", port: 47820 },
      notifications: { enabled: true },
      cloudOrgId: null,
      voice: { provider: "auto", language: "en", pushToTalkMode: "hold", pushToTalkShortcut: "Alt+Space" },
    });
    expect(infos.map((i) => i.id)).toEqual(["claude", "codex", "grok", "cursor"]);
    const byId = Object.fromEntries(infos.map((i) => [i.id, i]));
    // claude/cursor also probe fixed home paths (~/.local/bin/…), so only PATH-independent facts are asserted.
    expect(byId["claude"]).toMatchObject({ displayName: "Claude" });
    expect(typeof byId["claude"]?.installed).toBe("boolean");
    expect(byId["claude"]?.installHint).toContain("claude");
    expect(byId["codex"]).toMatchObject({ installed: true, version: process.versions.bun, path: custom });
    expect(byId["grok"]).toMatchObject({ installed: true, version: process.versions.bun, path: grokPath });
    expect(byId["cursor"]).toMatchObject({ displayName: "Cursor" });
    for (const info of infos) expect(info.models.length).toBeGreaterThan(0);
    // Only Claude Code can pause a tool call for approval (see each adapter for why).
    expect(infos.map((i) => [i.id, i.supportsSupervised])).toEqual([
      ["claude", true],
      ["codex", false],
      ["grok", false],
      ["cursor", false],
    ]);
  });
});
