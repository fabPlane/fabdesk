import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { Arch } = require("builder-util");
const afterPack = require("../../scripts/after-pack.cjs") as {
  copyBundledKicad: (context: unknown, src: string) => string;
  platformArch: (context: {
    electronPlatformName: string;
    arch: number | string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => { dir: string; resources: string };
};

describe("after-pack platform mapping", () => {
  test.skipIf(process.platform === "win32")(
    "keeps library aliases relative to the packaged app",
    () => {
      const root = mkdtempSync(join(tmpdir(), "fabdesk-after-pack-alias-"));
      const src = join(root, "staged");
      mkdirSync(src);
      writeFileSync(join(src, "lib.dylib"), "compiled-library");
      symlinkSync("lib.dylib", join(src, "alias.dylib"));
      try {
        const dest = afterPack.copyBundledKicad(
          {
            electronPlatformName: "darwin",
            arch: Arch.arm64,
            appOutDir: join(root, "packaged"),
            packager: { appInfo: { productFilename: "fabPlane" } },
          },
          src,
        );
        expect(readlinkSync(join(dest, "alias.dylib"))).toBe("lib.dylib");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  test("maps electron-builder's numeric ARM64 architecture to the staged bundle", () => {
    const result = afterPack.platformArch({
      electronPlatformName: "darwin",
      arch: Arch.arm64,
      appOutDir: "/tmp/release/mac-arm64",
      packager: { appInfo: { productFilename: "fabPlane" } },
    });

    expect(result.dir).toBe("darwin-arm64");
  });

  test("keeps x64 mapped to the Intel bundle", () => {
    const result = afterPack.platformArch({
      electronPlatformName: "darwin",
      arch: Arch.x64,
      appOutDir: "/tmp/release/mac",
      packager: { appInfo: { productFilename: "fabPlane" } },
    });

    expect(result.dir).toBe("darwin-x64");
  });
});
