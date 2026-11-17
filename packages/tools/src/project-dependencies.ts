import { createHash } from "node:crypto";
import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { componentModelEnvironment, parseLibraryTable, readSavedBoardModels, resolveModelPath } from "@fabdesk/kicad";
import { jailPath } from "./fs";
import { ToolError } from "./registry";

export type ProjectDependencies = { revision: string; files: Array<{ path: string; sha256: string | null }>; unresolved: string[]; external?: Array<{ declared: string; sha256: string | null }> };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Hash project rules, referenced library content and local model bytes, including missing inputs.
 * External/unresolved assets stay explicit; this does not certify model loading or physical fit. */
export async function snapshotProjectDependencies(dir: string): Promise<ProjectDependencies> {
  const files = new Map<string, string | null>();
  const unresolved = new Set<string>();
  const external = new Map<string, string | null>();
  const modelRoots = Object.entries(componentModelEnvironment()).filter(([key, value]) => /^KICAD\d+_3DMODEL_DIR$/.test(key) && value).map(([, value]) => value!);
  let bytes = 0, visited = 0;
  const directories = new Set<string>();
  const add = async (path: string) => {
    const safe = await jailPath(dir, path), rel = relative(dir, safe).split("\\").join("/");
    if (files.has(rel)) return;
    const info = await stat(safe).catch(() => null);
    if (++visited > 8192) throw new ToolError("Dependency snapshot exceeds 8192 entries", "precondition");
    if (info?.isDirectory()) {
      const canonical = await realpath(safe);
      if (directories.has(canonical)) return;
      directories.add(canonical);
      for (const entry of (await readdir(safe)).sort()) if (!entry.startsWith(".") && entry.endsWith(".kicad_mod")) await add(join(safe, entry));
      return;
    }
    if (files.size >= 4096 || info && (bytes += info.size) > 250 * 1024 * 1024) throw new ToolError("Dependency snapshot exceeds 4096 files or 250 MB", "precondition");
    files.set(rel, info?.isFile() ? hash(await readFile(safe)) : null);
  };
  const source = await readFile(join(dir, "board.kicad_pcb"), "utf8").catch(() => "");
  const sch = await readFile(join(dir, "board.kicad_sch"), "utf8").catch(() => "");
  const manifest = JSON.parse(await readFile(join(dir, "fabdesk.json"), "utf8").catch(() => "{}"));
  const modelDirectory = manifest.importedBoard?.path ? dirname(await jailPath(dir, manifest.importedBoard.path)) : dir;
  const used = new Set([...source.matchAll(/\(footprint\s+"([^":]+):/g), ...sch.matchAll(/\(lib_id\s+"([^":]+):/g)].map(m => m[1]));
  for (const path of ["board.kicad_pro", "board.kicad_dru", "fp-lib-table", "sym-lib-table"]) await add(path);
  for (const table of ["fp-lib-table", "sym-lib-table"]) {
    const text = await readFile(join(dir, table), "utf8").catch(() => "");
    for (const row of parseLibraryTable(text)) {
      if (!used.has(row.name) && !row.uri.includes("${KIPRJMOD}")) continue;
      const path = row.uri.replaceAll("${KIPRJMOD}", dir);
      try {
        if (row.type !== "KiCad" || /\$[({]/.test(path)) throw Error("unresolved library");
        await add(path);
      } catch (e) {
        if (e instanceof ToolError && e.code !== "invalid_args") throw e;
        unresolved.add(`library:${row.name}:${row.uri}`);
      }
    }
  }
  let footprints: ReturnType<typeof readSavedBoardModels> = [];
  try { if (source) footprints = readSavedBoardModels(source); } catch { unresolved.add("native model declarations unavailable"); }
  for (const fp of footprints) for (const model of fp.models) {
    const resolved = resolveModelPath(model.declared, modelDirectory);
    if (!resolved.path) { unresolved.add(`model:${model.declared}`); continue; }
    for (const path of [resolved.path, ...resolved.substitutionCandidates]) {
      try { await add(path); } catch (e) {
        if (e instanceof ToolError && e.code !== "invalid_args") throw e;
        let trusted = false;
        for (const root of modelRoots) {
          try {
            const safe = await jailPath(root, path), info = await stat(safe).catch(() => null);
            if (info && info.size > 50 * 1024 * 1024) throw new ToolError("External model exceeds 50 MB dependency limit", "precondition");
            external.set(`${model.declared}:${path.endsWith(".step") ? "step" : "model"}`, info?.isFile() ? hash(await readFile(safe)) : null);
            trusted = true; break;
          } catch (e) { if (e instanceof ToolError && e.code !== "invalid_args") throw e; }
        }
        if (!trusted) unresolved.add(`model:${model.declared}`);
      }
    }
  }
  const input = { files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 })), unresolved: [...unresolved].sort(), external: [...external].sort(([a], [b]) => a.localeCompare(b)).map(([declared, sha256]) => ({ declared, sha256 })) };
  return { revision: hash(JSON.stringify(input)), ...input };
}

export async function assertProjectDependencies(dir: string, before: ProjectDependencies): Promise<void> {
  if ((await snapshotProjectDependencies(dir)).revision !== before.revision) throw new ToolError("Project rules, libraries or model dependencies changed; regenerate the affected views and checks", "precondition");
}
