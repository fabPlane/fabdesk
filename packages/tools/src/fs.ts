/** File helpers shared by tools: path jail, JSON I/O, project file layout. */
import { randomUUID } from "node:crypto";
import { rm, mkdir, lstat, readFile, realpath, stat, writeFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ToolError } from "./registry";

/** Canonical file locations inside a project directory. */
export const PROJECT_FILES = {
  manifest: "fabdesk.json",
  /** The design source: what exists and what connects (`NetlistFile` in @fabdesk/protocol). */
  netlistJson: "circuit.netlist.json",
  /** The KiCad netlist the compile job wrote; `export_netlist` copies it. */
  compileNet: ".fabdesk/compile.net",
  boardPcb: "board.kicad_pcb",
  boardSch: "board.kicad_sch",
  boardPro: "board.kicad_pro",
  /** The mechanical model, a FreeCAD document (`cad` toolset). */
  cadModel: "model.FCStd",
  sketches: "sketches",
  renders: "renders",
  reports: "reports",
  exports: "exports",
  runs: ".fabdesk/runs",
  cache: ".fabdesk/cache",
} as const;

/**
 * Resolve `rel` under `root`, rejecting `..` escapes, absolute paths outside the root and symlinks
 * whose target leaves the root. Returns the absolute path (which may not exist yet).
 */
export async function jailPath(root: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.length === 0)
    throw new ToolError("path is required", "invalid_args");
  if (rel.includes("\0")) throw new ToolError("invalid path", "invalid_args");
  const rootAbs = resolve(root);
  const candidate = isAbsolute(rel) ? resolve(rel) : resolve(rootAbs, normalize(rel));
  const relToRoot = relative(rootAbs, candidate);
  if (relToRoot === "" || relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
    throw new ToolError(`path escapes the project directory: ${rel}`, "invalid_args");
  }
  // Walk existing ancestors and verify their real paths stay inside the (real) root.
  const realRoot = await realpath(rootAbs).catch(() => rootAbs);
  let probe = candidate;
  while (true) {
    const st = await lstat(probe).catch(() => null);
    if (st) {
      const real = await realpath(probe);
      const relReal = relative(realRoot, real);
      if (relReal.startsWith("..") || isAbsolute(relReal)) {
        throw new ToolError(
          `path resolves outside the project directory via symlink: ${rel}`,
          "invalid_args",
        );
      }
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return candidate;
}

export function projectRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function mtimeMs(path: string): Promise<number | null> {
  return stat(path).then(
    (s) => s.mtimeMs,
    () => null,
  );
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonOrNull<T = unknown>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

/** Atomic write: temp file + rename, creating parent dirs. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { flag: "wx" });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

export function projectPath(dir: string, ...parts: string[]): string {
  return join(dir, ...parts);
}
