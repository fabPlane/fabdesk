import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../../..");
const desktopRoot = join(import.meta.dir, "../..");

describe("PCB backend packaging", () => {
  test("electron-builder includes the target-specific backend on every platform", () => {
    const config = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");

    for (const target of ["darwin-${arch}", "linux-${arch}", "windows-${arch}"])
      expect(config).toContain(`from: ../../dist/pcb/${target}/`);
    expect(config).toContain("Contents/Resources/pcb/bin/fp-pcb-bridge");
  });

  test("release jobs fetch a backend pinned to the fab_pcb submodule revision", () => {
    const workflow = readFileSync(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("commit=\"$(git -C vendor/fab_pcb rev-parse HEAD)\"");
    expect(workflow).toContain('tag="backend-${commit:0:10}"');
    expect(workflow).toContain('asset="fp-pcb-backend-${target}.tar.gz"');
    expect(workflow).toContain('test -f "dist/pcb/$target/bundle.json"');
  });
});
