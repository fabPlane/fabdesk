import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Arch } = require("builder-util");
const afterPack = require("../../scripts/after-pack.cjs") as {
  platformArch: (context: {
    electronPlatformName: string;
    arch: number | string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => { dir: string; resources: string };
};

describe("after-pack platform mapping", () => {
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
