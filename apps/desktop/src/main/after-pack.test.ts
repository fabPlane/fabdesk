import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { Arch } = require("builder-util");
const afterPack = require("../../scripts/after-pack.cjs") as {
  copyBundledKicad: (context: unknown, src: string) => string;
  jreSigningBinaries: (appPath: string) => string[];
  platformArch: (context: {
    electronPlatformName: string;
    arch: number | string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => { dir: string; resources: string };
};

function macEngineFixture() {
  const root = mkdtempSync(join(tmpdir(), "fabdesk-pcb-engine-"));
  const src = join(root, "staged");
  const appOutDir = join(root, "packaged");
  const resources = join(appOutDir, "fabPlane.app/Contents/Resources");
  const backend = join(resources, "pcb/kicad");
  const context = {
    electronPlatformName: "darwin",
    arch: Arch.arm64,
    appOutDir,
    packager: { appInfo: { productFilename: "fabPlane" } },
  };
  const manifest = {
    format: 1,
    target: "darwin-arm64",
    kicadCli: "kicad/kicad-cli",
    stockData: "kicad/KiCad.app/Contents/SharedSupport",
  };
  const manifestPath = join(resources, "pcb/bundle.json");
  const loaders = join(src, "KiCad.app/Contents/PlugIns/3d");
  mkdirSync(loaders, { recursive: true });
  mkdirSync(backend, { recursive: true });
  for (const loader of ["oce", "vrml", "idf"])
    writeFileSync(join(loaders, `libs3d_plugin_${loader}.so`), "matching-model-loader");
  for (const path of [src, backend]) writeFileSync(join(path, "KICAD_COMMIT"), "a".repeat(40));
  writeFileSync(join(src, "kicad-cli"), "new-renderer");
  writeFileSync(join(backend, "kicad-cli"), "old-renderer");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, src, backend, context, manifest, manifestPath, loaders };
}

describe("after-pack platform mapping", () => {
  test.skipIf(process.platform === "win32")(
    "refreshes the actual PCB engine at a matching source pin and preserves aliases",
    () => {
      const fixture = macEngineFixture();
      try {
        writeFileSync(join(fixture.src, "lib.dylib"), "compiled-library");
        symlinkSync("lib.dylib", join(fixture.src, "alias.dylib"));
        afterPack.copyBundledKicad(fixture.context, fixture.src);
        expect(readFileSync(join(fixture.backend, "kicad-cli"), "utf8")).toBe("new-renderer");
        expect(readlinkSync(join(fixture.backend, "alias.dylib"))).toBe("lib.dylib");
        expect(JSON.parse(readFileSync(fixture.manifestPath, "utf8"))).toEqual(fixture.manifest);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  test.each(["source pin", "layout", "target", "model loader"])(
    "rejects a mismatched %s without replacing the PCB engine",
    (mismatch) => {
      const fixture = macEngineFixture();
      try {
        if (mismatch === "source pin")
          writeFileSync(join(fixture.backend, "KICAD_COMMIT"), "b".repeat(40));
        if (mismatch === "layout") fixture.manifest.kicadCli = "other/kicad-cli";
        if (mismatch === "target") fixture.manifest.target = "darwin-x64";
        if (mismatch === "model loader") rmSync(join(fixture.loaders, "libs3d_plugin_oce.so"));
        writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
        expect(() => afterPack.copyBundledKicad(fixture.context, fixture.src)).toThrow();
        expect(readFileSync(join(fixture.backend, "kicad-cli"), "utf8")).toBe("old-renderer");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
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
  test("enumerates java and every nested JRE dylib for hardened-runtime signing", async () => {
    const app = await mkdtemp(join(tmpdir(), "freerouting-mac-sign-"));
    try {
      const jre = "Contents/Resources/pcb/freerouting/jre";
      const paths = [`${jre}/bin/java`, `${jre}/lib/libjava.dylib`, `${jre}/lib/server/libjvm.dylib`];
      for (const path of [...paths, `${jre}/legal/LICENSE`]) {
        await mkdir(join(app, path, ".."), { recursive: true });
        await writeFile(join(app, path), "fixture");
      }
      expect(afterPack.jreSigningBinaries(app).sort()).toEqual(paths.sort());
    } finally { await rm(app, { recursive: true, force: true }); }
  });
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
