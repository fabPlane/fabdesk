import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** Run the real installer verifier against an extracted-payload fixture. No CAD engine executes. */
function verify(withInvalidCad: boolean) {
  const root = mkdtempSync(join(tmpdir(), "optional-cad-verifier-"));
  try {
    const resources = join(root, "payload/resources");
    for (const directory of ["core", "kicad", "pcb/data", "pcb/footprints", "pcb/symbols"])
      mkdirSync(join(resources, directory), { recursive: true });
    const core = join(resources, "core/fabdesk-core");
    writeFileSync(core, "#!/bin/sh\necho 0.2.144\n");
    chmodSync(core, 0o755);
    for (const path of ["kicad/kicad-cli", "pcb/bridge", "pcb/kicad-cli"])
      writeFileSync(join(resources, path), "fixture");
    writeFileSync(
      join(resources, "pcb/bundle.json"),
      JSON.stringify({
        format: 1,
        target: "linux-x64",
        bridge: "bridge",
        kicadCli: "kicad-cli",
        stockData: "data",
        footprints: "footprints",
        symbols: "symbols",
      }),
    );
    if (withInvalidCad) {
      mkdirSync(join(resources, "cad"));
      writeFileSync(
        join(resources, "cad/bundle.json"),
        JSON.stringify({
          format: 1,
          target: "linux-x64",
          engine: "mock",
        }),
      );
    }
    const installers = join(root, "installers");
    mkdirSync(installers);
    const image = join(installers, "fixture.AppImage");
    // bash invokes this fixture solely to exercise --appimage-extract in the real verifier.
    writeFileSync(image, `#!/bin/sh\ncp -R '${join(root, "payload")}' squashfs-root\n`);
    const result = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "../verify-installers.ts"),
        installers,
        "--target",
        `bun-${process.platform}-${process.arch}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FABDESK_REQUIRE_BUNDLED_KICAD: "1" },
      },
    );
    return {
      code: result.exitCode,
      output: Buffer.concat([result.stdout, result.stderr]).toString(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("main installer passes with PCB and no optional CAD payload", () => {
  const result = verify(false);
  expect(result.code).toBe(0);
  expect(result.output).toContain("CAD is optional");
});

test("an included CAD payload still requires a real native engine", () => {
  const result = verify(true);
  expect(result.code).toBe(1);
  expect(result.output).toContain("mock fallback is forbidden");
});
