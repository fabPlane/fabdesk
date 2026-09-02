import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, classify } from "../release-manifest";

describe("classify", () => {
  test("maps electron-builder artifact names", () => {
    expect(classify("Fabdesk-0.1.42-mac-arm64.dmg")).toEqual({ platform: "darwin", arch: "arm64", kind: "dmg" });
    expect(classify("Fabdesk-0.1.42-mac-x64.zip")).toEqual({ platform: "darwin", arch: "x64", kind: "zip" });
    expect(classify("Fabdesk-0.1.42-linux-x64.AppImage")).toEqual({ platform: "linux", arch: "x64", kind: "AppImage" });
    expect(classify("Fabdesk-0.1.42-linux-x64.deb")).toEqual({ platform: "linux", arch: "x64", kind: "deb" });
    expect(classify("Fabdesk-0.1.42-win-x64.exe")).toEqual({ platform: "win32", arch: "x64", kind: "exe" });
    expect(classify("Fabdesk-0.1.42-win-x64-portable.exe")).toEqual({ platform: "win32", arch: "x64", kind: "portable" });
    expect(classify("SHA256SUMS")).toBeNull();
  });
});

describe("buildManifest", () => {
  test("hashes every installer and writes sums", () => {
    const dir = mkdtempSync(join(tmpdir(), "fabdesk-rel-"));
    writeFileSync(join(dir, "Fabdesk-0.1.1-mac-arm64.dmg"), "hello");
    writeFileSync(join(dir, "Fabdesk-0.1.1-win-x64.exe"), "world");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const { manifest, sums } = buildManifest({ dir, version: "0.1.1", tag: "v0.1.1", repo: "TensorFleet/fabdesk", commit: "abc" });
    expect(manifest.assets).toHaveLength(2);
    expect(manifest.assets[0]?.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(manifest.assets[0]?.url).toBe("https://github.com/TensorFleet/fabdesk/releases/download/v0.1.1/Fabdesk-0.1.1-mac-arm64.dmg");
    expect(sums.split("\n").filter(Boolean)).toHaveLength(2);
    expect(manifest.notes).toBeUndefined();
  });
  test("carries trimmed release notes when given", () => {
    const dir = mkdtempSync(join(tmpdir(), "fabdesk-rel-"));
    writeFileSync(join(dir, "Fabdesk-0.1.1-mac-arm64.dmg"), "hello");
    const { manifest } = buildManifest({ dir, version: "0.1.1", tag: "v0.1.1", repo: "TensorFleet/fabdesk", commit: "abc", notes: "- Fix a thing\n- Add another\n" });
    expect(manifest.notes).toBe("- Fix a thing\n- Add another");
  });
});
