#!/usr/bin/env bun
// Run the full suite and verify it leaves every real staged KiCad bundle unchanged.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const staging = join(repoRoot, "apps/desktop/kicad-bundle");
async function snapshot(path: string): Promise<string[]> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return [`${path}:link:${await readlink(path)}`];
    if (stat.isDirectory()) {
      const entries = [`${path}:directory:${stat.mode}`];
      for (const name of (await readdir(path)).sort())
        entries.push(...(await snapshot(join(path, name))));
      return entries;
    }
    return [
      `${path}:file:${stat.mode}:${createHash("sha256")
        .update(await readFile(path))
        .digest("hex")}`,
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [`${path}:missing`];
    throw error;
  }
}
const before = await snapshot(staging);
const child = Bun.spawn(["bun", "run", "test"], {
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await child.exited;
const after = await snapshot(staging);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  console.error("FAIL: full test suite changed the real KiCad staging tree");
  process.exit(1);
}
console.log(
  `PASS: real KiCad staging tree unchanged across full test suite (${before.length} entries)`,
);
process.exit(code);
