#!/usr/bin/env bun
/** Stamps a release version into the root and app package.json files (CI only). */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run scripts/set-version.ts <major.minor.patch>");
  process.exit(2);
}
const root = fileURLToPath(new URL("..", import.meta.url));
for (const rel of ["package.json", "apps/desktop/package.json", "apps/core/package.json"]) {
  const file = join(root, rel);
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${rel}: ${version}`);
}
