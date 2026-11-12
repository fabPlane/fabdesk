/** Where the workflow keeps its records, and how it finds a project's KiCad files. */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

export const BOARD_DIR = ".fabdesk/board";

export interface ProjectFiles {
  dir: string;
  /** Project file stem (`board` for `board.kicad_pcb`). */
  stem: string;
  pcb: string;
  /** Absent when the project has no `.kicad_pro`. */
  pro: string | null;
}

export function boardHome(projectDir: string): string {
  return join(projectDir, BOARD_DIR);
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The project's board: `pcb` (relative to the project or absolute), else `board.kicad_pcb`, else the only `.kicad_pcb`. */
export async function locateProject(projectDir: string, pcb?: string): Promise<ProjectFiles> {
  let file: string;
  if (pcb) file = isAbsolute(pcb) ? pcb : join(projectDir, pcb);
  else {
    const names = (await readdir(projectDir)).filter((n) => n.endsWith(".kicad_pcb") && !n.startsWith("_autosave"));
    const pick = names.includes("board.kicad_pcb") ? "board.kicad_pcb" : names.length === 1 ? names[0] : undefined;
    if (!pick)
      throw new Error(
        names.length ? `several boards in ${projectDir} (${names.join(", ")}); name one` : `no .kicad_pcb in ${projectDir}`,
      );
    file = join(projectDir, pick);
  }
  if (!(await exists(file))) throw new Error(`${file} not found`);
  const stem = basename(file, ".kicad_pcb");
  const pro = join(file, "..", `${stem}.kicad_pro`);
  return { dir: projectDir, stem, pcb: file, pro: (await exists(pro)) ? pro : null };
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

/** Write atomically (temp file + rename) so a concurrent reader never sees half a record. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1) + "\n");
  await rename(tmp, path);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function topLevel(dir: string, suffixes: readonly string[]): Promise<string[]> {
  return (await readdir(dir))
    .filter((n) => suffixes.some((s) => n.endsWith(s)) && !n.startsWith("_autosave") && !n.startsWith("~"))
    .sort();
}

export interface DesignHash {
  /** Board, schematics, project settings and rule files (what the design is). */
  board: string;
  /** `board` plus the requirements (what the design must meet). */
  design: string;
  files: Record<string, string>;
}

/**
 * Content hash of the design: every `.kicad_pcb`, `.kicad_sch`, `.kicad_pro` and `.kicad_dru` in the
 * project folder (and schematic sheets under it), plus the requirements files for the full hash.
 * Paths are project-relative so the hash does not depend on where the project lives.
 */
export async function designHash(projectDir: string): Promise<DesignHash> {
  const files: Record<string, string> = {};
  const names = await topLevel(projectDir, [".kicad_pcb", ".kicad_sch", ".kicad_pro", ".kicad_dru"]);
  for (const n of names) files[n] = await sha256(join(projectDir, n));
  // sheets in sub-folders: one level, which is where KiCad projects keep them
  for (const e of await readdir(projectDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.endsWith(".pretty")) continue;
    const sub = join(projectDir, e.name);
    for (const n of await topLevel(sub, [".kicad_sch"])) files[relative(projectDir, join(sub, n))] = await sha256(join(sub, n));
  }
  const digest = (m: Record<string, string>) =>
    createHash("sha256")
      .update(JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)))))
      .digest("hex");
  const board = digest(files);
  const reqDir = join(boardHome(projectDir), "requirements");
  const all = { ...files };
  if (await exists(reqDir))
    for (const n of await topLevel(reqDir, [".json"])) all[`${BOARD_DIR}/requirements/${n}`] = await sha256(join(reqDir, n));
  return { board, design: digest(all), files };
}
