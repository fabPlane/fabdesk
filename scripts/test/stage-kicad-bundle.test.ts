import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NIGHTLY_PLATFORM_BY_TARGET,
  nightlyAssetName,
  pickKicadReleaseAsset,
  type Target,
} from "../stage-kicad-bundle";

describe("nightlyAssetName", () => {
  test.each([
    ["bun-darwin-arm64", "kicad-cli-macos-arm64.tar.gz"],
    ["bun-darwin-x64", "kicad-cli-macos-x86_64.tar.gz"],
    ["bun-linux-x64", "kicad-cli-linux-x86_64.tar.gz"],
    ["bun-windows-x64", "kicad-cli-windows-x86_64.zip"],
  ] as const)("%s → %s", (target, name) => {
    expect(nightlyAssetName(target)).toBe(name);
    expect(NIGHTLY_PLATFORM_BY_TARGET[target]).toBeTruthy();
  });
});

describe("pickKicadReleaseAsset", () => {
  const assets = [
    { name: "kicad-cli-macos-arm64.tar.gz", browser_download_url: "https://example/macos-arm64" },
    { name: "kicad-cli-macos-x86_64.tar.gz", browser_download_url: "https://example/macos-x64" },
    { name: "kicad-cli-linux-x86_64.tar.gz", browser_download_url: "https://example/linux-x64" },
    { name: "kicad-cli-windows-x86_64.zip", browser_download_url: "https://example/windows-x64" },
    { name: "manifest.json", browser_download_url: "https://example/manifest" },
  ];

  test.each([
    ["bun-darwin-arm64", "kicad-cli-macos-arm64.tar.gz"],
    ["bun-darwin-x64", "kicad-cli-macos-x86_64.tar.gz"],
    ["bun-linux-x64", "kicad-cli-linux-x86_64.tar.gz"],
    ["bun-windows-x64", "kicad-cli-windows-x86_64.zip"],
  ] as const)("%s → %s", (target, name) => {
    expect(pickKicadReleaseAsset(assets, target as Target)?.name).toBe(name);
  });

  test("returns null when no matching archive exists", () => {
    expect(pickKicadReleaseAsset([{ name: "manifest.json", browser_download_url: "x" }], "bun-linux-x64")).toBeNull();
  });

  test("does not pick arm64 when asking for x64", () => {
    expect(
      pickKicadReleaseAsset([{ name: "kicad-cli-linux-arm64.tar.gz", browser_download_url: "x" }], "bun-linux-x64"),
    ).toBeNull();
  });
});

describe("stage-kicad-bundle --from", () => {
  test("copies a local nightly-shaped KiCad tree into apps/desktop/kicad-bundle", async () => {
    const src = mkdtempSync(join(tmpdir(), "fabdesk-kicad-src-"));
    // Match the nightly archive layout after flattening `kicad-cli/`.
    if (process.platform === "win32") {
      mkdirSync(join(src, "bin"), { recursive: true });
      writeFileSync(join(src, "bin", "kicad-cli.exe"), "MZ");
    } else {
      writeFileSync(join(src, "kicad-cli"), "#!/bin/sh\necho stub\n");
      chmodSync(join(src, "kicad-cli"), 0o755);
    }

    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const target = `bun-${os}-${arch}`;
    const proc = Bun.spawn(["bun", "run", "scripts/stage-kicad-bundle.ts", "--from", src, "--target", target], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("staged");

    const stagedCli = join(
      import.meta.dir,
      "../../apps/desktop/kicad-bundle",
      `${os}-${arch}`,
      process.platform === "win32" ? "bin/kicad-cli.exe" : "kicad-cli",
    );
    expect(readFileSync(stagedCli, "utf8").length).toBeGreaterThan(0);
    rmSync(join(import.meta.dir, "../../apps/desktop/kicad-bundle", `${os}-${arch}`), { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });
});
