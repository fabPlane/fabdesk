import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  chmodSync,
  statSync,
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
  makeOwnerWritable: (root: string) => number;
  signAdHocSidecars: (
    appPath: string,
    binaries: string[],
    entitlements: string,
    run: (command: string, args: string[], options: unknown) => void,
  ) => void;
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
  test("explicitly applies JIT entitlements to core sidecars and skips absent optional tools", async () => {
    const app = await mkdtemp(join(tmpdir(), "fabdesk-core-sign-"));
    try {
      const core = "Contents/Resources/core/fabdesk-core";
      await mkdir(join(app, core, ".."), { recursive: true });
      await writeFile(join(app, core), "compiled-core fixture");
      const calls: Array<{ command: string; args: string[] }> = [];
      afterPack.signAdHocSidecars(
        app,
        [core, "Contents/Resources/speech/fabdesk-speech"],
        "app-jit-entitlements.plist",
        (command, args) => { calls.push({ command, args }); },
      );
      expect(calls).toEqual([{
        command: "codesign",
        args: ["--force", "--sign", "-", "--entitlements", "app-jit-entitlements.plist",
          "--options", "runtime", join(app, core)],
      }]);
    } finally {
      await rm(app, { recursive: true, force: true });
    }
  });
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
  test("makes read-only bundle files and folders owner-writable so Squirrel.Mac can update them", () => {
    const app = mkdtempSync(join(tmpdir(), "after-pack-writable-"));
    try {
      const legal = join(app, "Contents/Resources/pcb/freerouting/jre/legal/java.xml");
      mkdirSync(legal, { recursive: true });
      const notice = join(legal, "bcel.md");
      const java = join(app, "Contents/Resources/pcb/freerouting/jre/java");
      const plain = join(app, "Contents/Info.plist");
      writeFileSync(notice, "notice");
      writeFileSync(java, "binary");
      writeFileSync(plain, "plist");
      chmodSync(notice, 0o444);
      chmodSync(java, 0o555);
      chmodSync(legal, 0o555);
      symlinkSync("missing-target", join(app, "Contents/dangling"));

      expect(afterPack.makeOwnerWritable(app)).toBe(3);
      expect(statSync(notice).mode & 0o777).toBe(0o644);
      expect(statSync(java).mode & 0o777).toBe(0o755);
      expect(statSync(legal).mode & 0o777).toBe(0o755);
      expect(statSync(plain).mode & 0o777).toBe(0o644);
      expect(afterPack.makeOwnerWritable(app)).toBe(0);
    } finally {
      chmodSync(join(app, "Contents/Resources/pcb/freerouting/jre/legal/java.xml"), 0o755);
      rmSync(app, { recursive: true, force: true });
    }
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
