import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, resolveFirst, resolveWindowsShim } from "./detect";

/** Lays out what `npm install -g` leaves behind on Windows: a .cmd shim beside node_modules with the real exe. */
function npmShim(name: string): { shim: string; exe: string } {
  const dir = mkdtempSync(join(tmpdir(), "fabdesk-shim-"));
  const exe = join(dir, "node_modules", "@vendor", name, "bin", `${name}.exe`);
  mkdirSync(join(dir, "node_modules", "@vendor", name, "bin"), { recursive: true });
  writeFileSync(exe, "MZ");
  chmodSync(exe, 0o755);
  const shim = join(dir, `${name}.cmd`);
  writeFileSync(shim, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@vendor\\${name}\\bin\\${name}.exe"   %*\r\n`);
  return { shim, exe };
}

describe("npm .cmd shims on Windows", () => {
  test("resolveWindowsShim follows the shim to the executable it forwards to", () => {
    const { shim, exe } = npmShim("claude");
    expect(resolveWindowsShim(shim)).toBe(exe);
  });

  test("ignores non-shims and shims whose target is missing", () => {
    const { shim } = npmShim("codex");
    expect(resolveWindowsShim(shim.replace(/\.cmd$/, ".exe"))).toBeUndefined();
    writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\nowhere\\x.exe" %*\r\n');
    expect(resolveWindowsShim(shim)).toBeUndefined();
  });

  test.if(process.platform === "win32")("resolveBinary and resolveFirst hand adapters the exe, never the .cmd", () => {
    const { shim, exe } = npmShim("grok");
    expect(resolveBinary(shim)).toBe(exe);
    expect(resolveFirst(["definitely-not-installed-xyz", shim])).toBe(exe);
  });
});
