import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { commonBinDirs, detectBinary, resolveBinary } from "./detect";
import { detectAgents } from "./index";
import { readClaudeModelCatalog } from "./claude-models";
import { readCodexModelCatalog } from "./codex-models";

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
    // Names no machine has: bare names are also looked up in the common install folders.
    expect(
      await detectBinary(["fabdesk-absent-agent", "fabdesk-absent-cli", join(dir, "missing")]),
    ).toEqual({
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

describe("common install folders", () => {
  test("a bare name off PATH is found in a search folder; a path is not searched for", () => {
    const path = fakeBinary("codex");
    const name = basename(path);
    process.env["PATH"] = join(dir, "empty");
    expect(resolveBinary(name, [join(dir, "nowhere"), dir])).toBe(path);
    expect(resolveBinary(name, [])).toBeUndefined();
    expect(resolveBinary(join(dir, "sub", name), [dir])).toBeUndefined();
  });

  test("PATH wins over the search folders", () => {
    const onPath = fakeBinary("codex");
    const other = mkdtempSync(join(tmpdir(), "fabdesk-detect-other-"));
    try {
      copyFileSync(process.execPath, join(other, "codex"));
      expect(resolveBinary("codex", [other])).toBe(onPath);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("cover Homebrew and the home folder", () => {
    expect(commonBinDirs("/Users/me", "darwin")).toEqual(
      expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.local/bin"]),
    );
    expect(commonBinDirs("/home/me", "linux")).toContain("/home/me/.npm-global/bin");
    expect(commonBinDirs("C:\\Users\\me", "win32")).toEqual([]);
  });
});

describe("detectAgents", () => {
  test("desktop version and model probes request hidden consoles", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("CLI unavailable"); });
    try {
      await detectBinary([], process.execPath);
      await readClaudeModelCatalog(process.execPath, "test-hidden-probe");
      await readCodexModelCatalog(process.execPath, "test-hidden-probe");
      for (const arg of ["--version", "-p", "app-server"]) {
        expect(spawn).toHaveBeenCalledWith(
          expect.arrayContaining([process.execPath, arg]),
          expect.objectContaining({ windowsHide: true }),
        );
      }
    } finally {
      spawn.mockRestore();
    }
  });

  test("returns one AgentInfo per adapter with install hints and settings overrides", async () => {
    const grokPath = fakeBinary("grok");
    const custom = fakeBinary("codex-custom");
    const infos = await detectAgents({
      kicadCliPath: null,
      ngspicePath: null,
      fpPcbBridgeUrl: null,
      router: "fab_router",
      tracemakerManifestUrl: null,
      krtDir: null,
      autoInstallEngines: true,
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
      uiLocale: "system",
      agentReplyLanguage: "match",
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
