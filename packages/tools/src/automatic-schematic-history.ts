import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectProjectBoardSources } from "./assembly";
import { jailPath, writeJson } from "./fs";
import type { ToolContext } from "./registry";

const generationName = /^auto-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const marker = ".automatic-files.json";

/** Output receipts may retain individual sheet paths after the live viewer moves on. */
async function referencedVersions(ctx: ToolContext) {
  const project = ctx.boardRoot ?? ctx.requireProject();
  const directories = new Set([project.dir, ctx.requireProject().dir]);
  if (ctx.boardRoot) {
    const boards = await inspectProjectBoardSources(project);
    for (const row of boards.sources) {
      if (row.status === "available" && row.source.location === "project") {
        directories.add(resolve(project.dir, row.source.directory));
      }
    }
  }
  const retained = new Set<string>();
  async function scan(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!generationName.test(entry.name)) await scan(path);
      } else if (entry.name.endsWith(".revision.json") || entry.name === "product-video.json") {
        if (!entry.isFile() || (await lstat(path)).size > 2_000_000) throw new Error("Cannot verify retained output references");
        const record = await readFile(path, "utf8");
        // Parse first so a partially written or corrupt receipt defers collection.
        JSON.parse(record);
        for (const id of record.match(/auto-[a-f0-9-]{36}/g) ?? []) retained.add(id);
      }
    }
  }
  for (const directory of directories) {
    for (const name of ["renders", "exports"]) {
      const path = await jailPath(directory, name);
      if (await realpath(path).catch(() => path) !== resolve(path)) throw new Error("Aliased output directory");
      await scan(path);
    }
  }
  return retained;
}

/** Collect only completed automatic generations. Manual exports and legacy UUID paths stay immutable. */
export async function recordAutomaticSchematicVersion(ctx: ToolContext, version: string, files: ReadonlyArray<readonly [string, string]>) {
  const root = ctx.requireProject().dir;
  try {
    const directory = await jailPath(root, "renders/schematic");
    if (await realpath(directory) !== resolve(directory)) return;
    await writeJson(await jailPath(root, version + "/" + marker), Object.fromEntries(files.map(([path, sha]) => [basename(path), sha])));
    const completed: Array<{ name: string; time: number }> = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !generationName.test(entry.name)) continue;
      const info = await lstat(join(directory, entry.name, marker)).catch(() => null);
      if (info?.isFile()) completed.push({ name: entry.name, time: info.mtimeMs });
    }
    if (completed.length <= 2) return;
    const retained = await referencedVersions(ctx);
    completed.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
    retained.add(basename(version));
    // Keep the preceding complete generation for readers already displaying its sheets.
    const previous = completed.find(entry => entry.name !== basename(version));
    if (previous) retained.add(previous.name);
    for (const { name } of completed) {
      if (retained.has(name)) continue;
      const path = await jailPath(root, "renders/schematic/" + name);
      if (await realpath(path) !== resolve(path)) continue;
      const manifest = join(path, marker);
      const hashes = JSON.parse(await readFile(manifest, "utf8")) as Record<string, string>;
      const entries = (await readdir(path, { withFileTypes: true })).filter(entry => entry.name !== marker);
      // A previous cleanup may already have removed some of its own files.
      let intact = true;
      for (const entry of entries) {
        if (!entry.isFile() || !/^sheet-[1-9]\d*\.(svg|png)$/.test(entry.name) ||
          createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex") !== hashes[entry.name]) {
          intact = false;
          break;
        }
      }
      if (!intact) continue;
      for (const entry of entries) await unlink(join(path, entry.name));
      await unlink(manifest);
      await rmdir(path);
    }
  } catch (error) {
    // Another collector or reader can hold a file on Windows. A later publication retries.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Schematic preview history cleanup deferred", error);
  }
}
