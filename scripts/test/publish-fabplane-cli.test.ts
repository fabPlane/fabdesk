import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const workflow = readFileSync(join(root, ".github/workflows/publish-fabplane-cli.yml"), "utf8");
const docs = readFileSync(join(root, "docs/fabplane-cli.md"), "utf8");

describe("publish-fabplane-cli workflow", () => {
  test("publishes only on cli-v* tags and requires NPM_TOKEN first", () => {
    expect(workflow).toContain('tags:\n      - "cli-v*"');
    expect(workflow).not.toContain("pull_request");
    expect(workflow).not.toContain("workflow_dispatch");
    const steps = workflow.slice(workflow.indexOf("steps:"));
    expect(steps.indexOf("Check NPM_TOKEN")).toBeLessThan(steps.indexOf("actions/checkout"));
    expect(workflow).toContain("secrets.NPM_TOKEN");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).not.toMatch(/npm publish[^\n]*--provenance/);
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).toContain("working-directory: vendor/fabplane-cli");
    expect(workflow).toContain("cp -a vendor/fabplane-cli");
    expect(workflow).toContain("${RUNNER_TEMP}/fabplane-cli-publish");
    expect(workflow).toContain("working-directory: ${{ runner.temp }}/fabplane-cli-publish");
    expect(workflow).toContain("TensorFleet/fabdesk is");
    expect(workflow).toContain("private");
  });

  test.skipIf(!Bun.which("npm"))("npm ci inside the bun workspace walks up and fails; a copy outside it installs", () => {
    // npm reports canonical paths, including macOS /private/var rather than /var.
    const temporaryRoot = realpathSync(tmpdir());
    const seed = mkdtempSync(join(temporaryRoot, "fabplane-cli-seed-"));
    const parent = mkdtempSync(join(temporaryRoot, "fabplane-cli-ws-"));
    const child = join(parent, "vendor-cli");
    const isolated = join(temporaryRoot, `fabplane-cli-iso-${Date.now()}`);
    try {
      writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "tiny-cli", version: "1.0.0" }));
      const lock = Bun.spawnSync(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: seed,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (lock.exitCode !== 0) {
        throw new Error(`fixture lockfile failed: ${lock.stderr.toString() || lock.stdout.toString()}`);
      }
      mkdirSync(child, { recursive: true });
      writeFileSync(join(parent, "package.json"), JSON.stringify({ private: true, workspaces: ["vendor-cli"] }));
      cpSync(join(seed, "package.json"), join(child, "package.json"));
      cpSync(join(seed, "package-lock.json"), join(child, "package-lock.json"));

      const inWorkspace = Bun.spawnSync(["npm", "prefix"], { cwd: child, stdout: "pipe", stderr: "pipe" });
      expect(inWorkspace.stdout.toString().trim()).toBe(parent);
      const ciInPlace = Bun.spawnSync(["npm", "ci", "--no-audit", "--no-fund"], {
        cwd: child,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ciInPlace.exitCode).not.toBe(0);

      cpSync(child, isolated, { recursive: true });
      const copied = Bun.spawnSync(["npm", "prefix"], { cwd: isolated, stdout: "pipe", stderr: "pipe" });
      expect(copied.stdout.toString().trim()).toBe(isolated);
      const ciCopied = Bun.spawnSync(["npm", "ci", "--no-audit", "--no-fund"], {
        cwd: isolated,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ciCopied.exitCode).toBe(0);
    } finally {
      rmSync(seed, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("does not publish when the version is already on npm", () => {
    const publish = workflow.slice(workflow.indexOf("- name: npm publish"));
    expect(publish).toContain("steps.published.outputs.exists == 'false'");
    expect(publish).not.toContain("steps.token.outputs.present");
  });

  test("docs say to bump the submodule pin before tagging a newer version", () => {
    expect(docs).toContain("bun run submodules:update");
    expect(docs).toContain("0.1.0");
    expect(docs).toMatch(/bump PR must land before the first tag/i);
    expect(docs).toContain("Do not push `cli-v0.1.0`");
    expect(docs).toContain("cli-v0.3.0");
    expect(docs).toContain("without `--provenance`");
    expect(docs).toContain("npm publish --provenance --access public"); // upstream repo path only
    expect(docs).toContain("granular");
    expect(docs).toContain("Bypass 2FA");
  });
});
