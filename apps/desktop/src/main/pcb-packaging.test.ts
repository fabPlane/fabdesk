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
    expect(config).toContain("Contents/Resources/pcb/freerouting/jre/bin/java");
    expect(config).toContain("Every JRE dylib is added to this list");
  });

  test("release jobs fetch a backend pinned to the fab_pcb submodule revision", () => {
    const workflow = readFileSync(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain('commit="$(git -C vendor/fab_pcb rev-parse HEAD)"');
    expect(workflow).toContain('tag="backend-${commit:0:10}"');
    expect(workflow).toContain('asset="fp-pcb-backend-${target}.tar.gz"');
    expect(workflow).toContain('test -f "dist/pcb/$target/bundle.json"');
    expect(workflow).toContain("backend does not contain fab_router");
    expect(workflow).toContain("backend does not contain Freerouting");
    expect(workflow).not.toMatch(/js[_-]autorouter/i);
  });

  test("installer CI tests the exact triggering build instead of site latest", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/installer-test.yml"),
      "utf8",
    );

    expect(workflow).toContain('echo "args=--run $RUN_ID"');
    expect(workflow).not.toContain("internal build?); testing the site's latest");
  });

  test("installer verification resolves the packaged PCB manifest", () => {
    const verifier = readFileSync(join(repositoryRoot, "scripts/verify-installers.ts"), "utf8");

    expect(verifier).toContain("resolvePcbBackend({ packaged: true");
    expect(verifier).toContain("bundled PCB manifest is invalid");
    expect(verifier).toContain("backend does not contain Freerouting jar and Java");
    expect(verifier.match(/checkPcbBundle\(/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
