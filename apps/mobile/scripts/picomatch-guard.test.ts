import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { findPicomatches, verifyPatchedFiles, testMatching } = require("./picomatch-guard.cjs") as {
  findPicomatches(root: string): string[];
  verifyPatchedFiles(paths: string[]): void;
  testMatching(path: string): void;
};
const root = join(import.meta.dir, "..");

test("checks every installed copy with Node/V8 and retains ordinary glob behavior", () => {
  const paths = findPicomatches(root);
  verifyPatchedFiles(paths);
  for (const path of paths) testMatching(path);
}, 15000);

test("refuses a missing, unknown or tampered parser", () => {
  expect(() => verifyPatchedFiles([])).toThrow("No installed");
  const temp = mkdtempSync(join(tmpdir(), "picomatch-tamper-"));
  try {
    const source = findPicomatches(root)[0]!;
    cpSync(source, temp, { recursive: true });
    writeFileSync(join(temp, "lib/parse.js"), readFileSync(join(temp, "lib/parse.js"), "utf8") + "\n// changed\n");
    expect(() => verifyPatchedFiles([temp])).toThrow("Unverified");
    writeFileSync(join(temp, "package.json"), JSON.stringify({ name: "picomatch", version: "0.0.0" }));
    expect(() => verifyPatchedFiles([temp])).toThrow("Unverified");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("the attack regression fails when the guard is removed from either version", () => {
  const versions = new Set<string>();
  for (const source of findPicomatches(root)) {
    const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version as string;
    if (versions.has(version)) continue;
    versions.add(version);
    const temp = mkdtempSync(join(tmpdir(), "picomatch-unpatched-"));
    try {
      cpSync(source, temp, { recursive: true });
      const file = join(temp, "lib/parse.js");
      const text = readFileSync(file, "utf8");
      const guard = "  if (branches.some(hasUnboundedWildcard)) {\n    return { risky: true };\n  }\n\n";
      expect(text).toContain(guard);
      writeFileSync(file, text.replace(guard, ""));
      expect(() => testMatching(temp)).toThrow("regression failed");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  expect([...versions].sort()).toEqual(["2.3.2", "4.0.7"]);
}, 15000);
