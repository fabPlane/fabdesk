/** Where the workflow keeps its records, and how it finds a project's KiCad files. */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** `child` is `parent` or lies under it (both already resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `path` (relative to the project or absolute) resolved inside `projectDir`, following symlinks, or an error naming
 * it: a board tool never reads or writes a file outside the project it was given. The file must exist.
 */
export async function confineToProject(projectDir: string, path: string, what = "file"): Promise<string> {
  const file = isAbsolute(path) ? resolve(path) : resolve(projectDir, path);
  if (!(await exists(file))) throw new Error(`${file} not found`);
  const [root, real] = await Promise.all([realpath(projectDir), realpath(file)]);
  if (!isInside(root, real)) throw new Error(`${what} ${path} is outside the project (${projectDir})`);
  return file;
}

/** The project's board: `pcb` (relative to the project or absolute, inside it), else `board.kicad_pcb`, else the only `.kicad_pcb`. */
export async function locateProject(projectDir: string, pcb?: string): Promise<ProjectFiles> {
  let file: string;
  if (pcb) file = await confineToProject(projectDir, pcb, "board");
  else {
    const names = (await readdir(projectDir)).filter((n) => n.endsWith(".kicad_pcb") && !n.startsWith("_autosave"));
    const pick = names.includes("board.kicad_pcb") ? "board.kicad_pcb" : names.length === 1 ? names[0] : undefined;
    if (!pick)
      throw new Error(
        names.length ? `several boards in ${projectDir} (${names.join(", ")}); name one` : `no .kicad_pcb in ${projectDir}`,
      );
    file = await confineToProject(projectDir, pick, "board");
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

/** Sheet files a schematic names: `(property "Sheetfile" "...")` (KiCad 7+) or `"Sheet file"` (KiCad 6). */
export function sheetRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\(property\s+"Sheet ?[Ff]ile"\s+"((?:[^"\\]|\\.)*)"/g)) {
    const name = m[1]!.replace(/\\(.)/g, "$1").trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * Content hash of the design: every `.kicad_pcb`, `.kicad_sch`, `.kicad_pro` and `.kicad_dru` in the project folder,
 * schematic sheets one folder down, and every sheet the schematics reference (followed from sheet to sheet, at any depth
 * and outside the folder too; a referenced sheet that is missing hashes as "MISSING"), plus the requirements files for
 * the full hash. Keys are project-relative paths with "/" so the hash does not depend on where the project lives.
 */
export async function designHash(projectDir: string): Promise<DesignHash> {
  const files: Record<string, string> = {};
  const keyOf = (abs: string) => relative(projectDir, abs).split(sep).join("/");
  const names = await topLevel(projectDir, [".kicad_pcb", ".kicad_sch", ".kicad_pro", ".kicad_dru"]);
  for (const n of names) files[n] = await sha256(join(projectDir, n));
  const sheets = names.filter((n) => n.endsWith(".kicad_sch")).map((n) => join(projectDir, n));
  // sheets in sub-folders: one level, which is where KiCad projects usually keep them
  for (const e of await readdir(projectDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name.endsWith(".pretty")) continue;
    const sub = join(projectDir, e.name);
    for (const n of await topLevel(sub, [".kicad_sch"])) {
      files[keyOf(join(sub, n))] = await sha256(join(sub, n));
      sheets.push(join(sub, n));
    }
  }
  // and every sheet the design references, however deep or wherever it lives
  const seen = new Set(sheets.map((p) => resolve(p)));
  const queue = [...seen];
  while (queue.length) {
    const sheet = queue.shift()!;
    const text = await readFile(sheet, "utf8").catch(() => null);
    if (text === null) continue;
    for (const ref of sheetRefs(text)) {
      const abs = resolve(dirname(sheet), ref.replaceAll("\\", "/"));
      if (seen.has(abs)) continue;
      seen.add(abs);
      const key = keyOf(abs);
      if (await exists(abs)) {
        files[key] = await sha256(abs);
        queue.push(abs);
      } else files[key] = "MISSING";
    }
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
