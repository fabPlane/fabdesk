import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(!Bun.which("7z"))("a flat Windows installer requires a nonempty PCB preload in its own resources tree", () => {
  const root = mkdtempSync(join(tmpdir(), "windows-preload-verifier-"));
  try {
    const installers = join(root, "installers");
    const app = join(root, "FabDesk App", "resources");
    mkdirSync(join(app, "core"), { recursive: true });
    mkdirSync(join(app, "pcb"));
    mkdirSync(installers);
    writeFileSync(join(app, "core", "fabdesk-core.exe"), "core fixture");
    const preload = join(app, "pcb", "fabdesk-hide-pcb-console.cjs");
    const file = join(installers, "fixture.exe");
    const verify = () => {
      rmSync(file, { force: true });
      const archive = Bun.spawnSync(["7z", "a", "-t7z", file, "FabDesk App"], { cwd: root, windowsHide: true });
      expect(archive.exitCode).toBe(0);
      return Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../verify-installers.ts"), installers, "--target", "bun-windows-x64"], {
        windowsHide: true, stdout: "pipe", stderr: "pipe",
      });
    };
    for (const contents of [null, ""]) {
      if (contents !== null) writeFileSync(preload, contents);
      const result = verify();
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("PCB console preload is missing or empty");
    }
    writeFileSync(preload, "// fixture");
    expect(verify().exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
