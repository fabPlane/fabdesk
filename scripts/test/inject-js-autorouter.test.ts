import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectJsAutorouter } from "../inject-js-autorouter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("injectJsAutorouter", () => {
  test("copies only the runtime package and records its immutable commit", () => {
    const root = mkdtempSync(join(tmpdir(), "fabdesk-router-inject-"));
    roots.push(root);
    const bundleDir = join(root, "bundle");
    const routerDir = join(root, "router");
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(join(routerDir, "src"), { recursive: true });
    writeFileSync(join(bundleDir, "bundle.json"), '{"format":1,"target":"linux-x64"}\n');
    writeFileSync(
      join(routerDir, "package.json"),
      '{"name":"@tensorfleet/js-autorouter","private":true}\n',
    );
    writeFileSync(join(routerDir, "src", "index.ts"), "export const route = true;\n");

    const commit = "0123456789abcdef0123456789abcdef01234567";
    injectJsAutorouter({ bundleDir, routerDir, commit });

    const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8"));
    expect(manifest.jsAutorouter).toBe("private/js_autorouter/src/index.ts");
    expect(manifest.jsAutorouterCommit).toBe(commit);
    expect(readFileSync(join(bundleDir, manifest.jsAutorouter), "utf8")).toContain("route = true");
  });

  test("rejects router packages with uncopied runtime dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "fabdesk-router-inject-"));
    roots.push(root);
    const bundleDir = join(root, "bundle");
    const routerDir = join(root, "router");
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(join(routerDir, "src"), { recursive: true });
    writeFileSync(join(bundleDir, "bundle.json"), '{"format":1}\n');
    writeFileSync(
      join(routerDir, "package.json"),
      '{"name":"@tensorfleet/js-autorouter","private":true,"dependencies":{"x":"1"}}\n',
    );
    writeFileSync(join(routerDir, "src", "index.ts"), "export {};\n");

    expect(() =>
      injectJsAutorouter({
        bundleDir,
        routerDir,
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toThrow("runtime dependencies");
  });
});
