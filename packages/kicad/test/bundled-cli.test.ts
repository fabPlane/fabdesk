import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledKicadCliCandidates, bundledKicadRoots, findKicadCli } from "../src/cli";

describe("bundledKicadRoots", () => {
  test("prefers FABDESK_BUNDLED_KICAD then FABDESK_RESOURCES/kicad then sibling of execPath", () => {
    const roots = bundledKicadRoots(
      { FABDESK_BUNDLED_KICAD: "/bundle/kicad", FABDESK_RESOURCES: "/Resources" },
      "/Resources/core/fabdesk-core",
    );
    expect(roots[0]).toBe("/bundle/kicad");
    expect(roots).toContain(join("/Resources", "kicad"));
    expect(roots).toContain(join("/Resources/core", "..", "kicad"));
  });
});

describe("bundledKicadCliCandidates", () => {
  test("emits nightly-shaped paths under each root", () => {
    const c = bundledKicadCliCandidates(["/k"]);
    if (process.platform === "darwin") {
      expect(c[0]).toBe("/k/kicad-cli");
      expect(c).toContain("/k/KiCad.app/Contents/MacOS/kicad-cli");
    } else if (process.platform === "win32") {
      expect(c[0]).toBe(join("/k", "bin", "kicad-cli.exe"));
    } else {
      expect(c[0]).toBe("/k/kicad-cli");
      expect(c).toContain("/k/kicad-cli/kicad-cli");
      expect(c).toContain("/k/bin/kicad-cli");
    }
  });
});

function writeVersionStub(path: string, version: string): void {
  writeFileSync(
    path,
    `#!/bin/bash
if [ "$1" = "version" ]; then echo "${version}"; exit 0; fi
echo "unexpected $*" >&2
exit 1
`,
  );
  chmodSync(path, 0o755);
}

describe.skipIf(process.platform === "win32")("findKicadCli bundled preference", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.KICAD_CLI;
    delete process.env.FABDESK_BUNDLED_KICAD;
    delete process.env.FABDESK_RESOURCES;
  });

  test("finds a staged fake kicad-cli via FABDESK_BUNDLED_KICAD", async () => {
    const root = join(tmpdir(), `fabdesk-kicad-bundle-${process.pid}-${Date.now()}`);
    dirs.push(root);
    mkdirSync(root, { recursive: true });
    // Nightly archive layout: launcher at <root>/kicad-cli (Linux/macOS).
    const cli = join(root, "kicad-cli");
    writeVersionStub(cli, "10.99.0-fabplane");
    process.env.FABDESK_BUNDLED_KICAD = root;
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const found = await findKicadCli();
      expect(found?.path).toBe(cli);
      expect(found?.version).toBe("10.99.0-fabplane");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("Settings/explicit path still wins over the bundle", async () => {
    const root = join(tmpdir(), `fabdesk-kicad-explicit-${process.pid}-${Date.now()}`);
    dirs.push(root);
    mkdirSync(root, { recursive: true });
    const override = join(root, "override-cli");
    const bundledCli = join(root, "kicad-cli");
    writeVersionStub(override, "9.0.0-override");
    writeVersionStub(bundledCli, "10.99.0-bundled");
    process.env.FABDESK_BUNDLED_KICAD = root;
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const found = await findKicadCli(override);
      expect(found?.path).toBe(override);
      expect(found?.version).toBe("9.0.0-override");
    } finally { process.env.PATH = savedPath; }
  });
});
