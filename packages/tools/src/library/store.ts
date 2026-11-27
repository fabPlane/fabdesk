/**
 * File-backed project library. Documents live under `files/` so they stay with git, export and sharing.
 * `files/library.json` holds tags, folders and component links; unlisted files already in `files/`
 * are discovered on list (same pattern as sketches/).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, sep } from "node:path";
import {
  LIBRARY_MAX_ENTRIES,
  LIBRARY_MAX_FILE_BYTES,
  LibraryEntry,
  LibraryEntryPatch,
  ProjectLibraryFile,
  defaultLibraryFolder,
  emptyProjectLibraryFile,
  libraryKindForName,
  type LibraryKind,
} from "@fabdesk/protocol";
import { PROJECT_FILES, exists, jailPath, projectRelative, writeAtomic, writeJson } from "../fs";
import { ToolError } from "../registry";

/** Library storage only needs the project root; sharing uses the same `{ dir }` handle. */
export type LibraryRoot = { dir: string };

export const LIBRARY_MANIFEST = PROJECT_FILES.libraryManifest;

const locks = new Map<string, Promise<unknown>>();

export function newLibraryId(): string {
  return `fil_${randomBytes(6).toString("hex")}`;
}

export function stableLibraryId(path: string): string {
  return `fil_${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export async function libraryDir(project: LibraryRoot): Promise<string> {
  return jailPath(project.dir, PROJECT_FILES.library);
}

export async function libraryManifestPath(project: LibraryRoot): Promise<string> {
  return jailPath(project.dir, LIBRARY_MANIFEST);
}

export async function loadLibraryFile(project: LibraryRoot): Promise<ProjectLibraryFile> {
  const path = await libraryManifestPath(project);
  if (!(await exists(path))) return emptyProjectLibraryFile();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ToolError(`${LIBRARY_MANIFEST} is not valid JSON`, "precondition");
  }
  const parsed = ProjectLibraryFile.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError(
      `${LIBRARY_MANIFEST} does not match fabplane.project-library: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "precondition",
    );
  }
  return parsed.data;
}

export async function saveLibraryFile(project: LibraryRoot, file: ProjectLibraryFile): Promise<void> {
  await writeJson(await libraryManifestPath(project), ProjectLibraryFile.parse(file));
}

async function walkFiles(root: string, rel = ""): Promise<string[]> {
  const dir = rel ? join(root, rel) : root;
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of names) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      out.push(...(await walkFiles(root, child)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".") || child === "library.json" || child.endsWith(".tmp")) continue;
    out.push(child);
  }
  return out;
}

function discoveredEntry(rel: string, now: string): LibraryEntry {
  const posixPath = `${PROJECT_FILES.library}/${toPosix(rel)}`;
  const name = basename(rel);
  const kind = libraryKindForName(name);
  const folder = posix.dirname(toPosix(rel));
  return LibraryEntry.parse({
    id: stableLibraryId(posixPath),
    path: posixPath,
    title: name.replace(/\.[^.]+$/, "") || name,
    kind,
    folder: folder === "." ? defaultLibraryFolder(kind) : folder,
    tags: [],
    linkedRefs: [],
    linkedMpns: [],
    addedAt: now,
    updatedAt: now,
  });
}

export type LibraryListedEntry = LibraryEntry & { bytes: number; mtime: string };

export async function listLibrary(project: LibraryRoot): Promise<LibraryListedEntry[]> {
  const root = await libraryDir(project);
  await mkdir(root, { recursive: true });
  const file = await loadLibraryFile(project);
  const disk = await walkFiles(root);
  const byPath = new Map(file.entries.map((entry) => [entry.path, entry]));
  const now = nowIso();
  const listed: LibraryListedEntry[] = [];
  for (const rel of disk.sort()) {
    const path = `${PROJECT_FILES.library}/${toPosix(rel)}`;
    const st = await stat(join(root, rel)).catch(() => null);
    if (!st?.isFile()) continue;
    const meta = byPath.get(path) ?? discoveredEntry(rel, now);
    listed.push({
      ...meta,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
    });
  }
  return listed;
}

export function safeLibraryName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  return base.slice(0, 120);
}

export function libraryFolderRel(folder: string): string {
  const cleaned = folder
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || "other";
}

export async function addLibraryFile(
  project: LibraryRoot,
  input: {
    filename: string;
    data: Uint8Array;
    title?: string;
    kind?: LibraryKind;
    folder?: string;
    tags?: string[];
    linkedRefs?: string[];
    linkedMpns?: string[];
  },
): Promise<LibraryListedEntry> {
  if (input.data.byteLength > LIBRARY_MAX_FILE_BYTES)
    throw new ToolError(`library files must be ${LIBRARY_MAX_FILE_BYTES} bytes or smaller`, "invalid_args");
  const name = safeLibraryName(input.filename);
  const kind = input.kind ?? libraryKindForName(name);
  const folder = libraryFolderRel(input.folder ?? defaultLibraryFolder(kind));
  return withLibraryLock(project, async () => {
    const file = await loadLibraryFile(project);
    if (file.entries.length >= LIBRARY_MAX_ENTRIES)
      throw new ToolError(`at most ${LIBRARY_MAX_ENTRIES} library files per project`, "precondition");
    const root = await libraryDir(project);
    const dir = join(root, folder);
    await mkdir(dir, { recursive: true });
    let final = name;
    for (let i = 2; await exists(join(dir, final)); i++) {
      const ext = extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      final = `${stem}-${i}${ext}`;
    }
    const abs = await jailPath(project.dir, `${PROJECT_FILES.library}/${folder}/${final}`);
    await writeAtomic(abs, input.data);
    const rel = projectRelative(project.dir, abs);
    const ts = nowIso();
    const entry = LibraryEntry.parse({
      id: newLibraryId(),
      path: rel,
      title: input.title?.trim() || final.replace(/\.[^.]+$/, "") || final,
      kind,
      folder,
      tags: input.tags ?? [],
      linkedRefs: input.linkedRefs ?? [],
      linkedMpns: input.linkedMpns ?? [],
      addedAt: ts,
      updatedAt: ts,
    });
    file.entries.push(entry);
    file.updatedAt = ts;
    await saveLibraryFile(project, file);
    const st = await stat(abs);
    return { ...entry, bytes: st.size, mtime: st.mtime.toISOString() };
  });
}

export async function patchLibraryEntry(
  project: LibraryRoot,
  id: string,
  patch: LibraryEntryPatch,
): Promise<LibraryListedEntry> {
  return withLibraryLock(project, async () => {
    const file = await loadLibraryFile(project);
    const listed = await listLibrary(project);
    const current = listed.find((entry) => entry.id === id);
    if (!current) throw new ToolError(`library file not found: ${id}`, "not_found");
    const ts = nowIso();
    const next = LibraryEntry.parse({
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.folder !== undefined ? { folder: libraryFolderRel(patch.folder) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.linkedRefs !== undefined ? { linkedRefs: patch.linkedRefs } : {}),
      ...(patch.linkedMpns !== undefined ? { linkedMpns: patch.linkedMpns } : {}),
      updatedAt: ts,
    });
    const without = file.entries.filter((entry) => entry.path !== current.path && entry.id !== id);
    file.entries = [...without, next];
    file.updatedAt = ts;
    await saveLibraryFile(project, file);
    const st = await stat(await jailPath(project.dir, next.path));
    return { ...next, bytes: st.size, mtime: st.mtime.toISOString() };
  });
}

export async function removeLibraryEntry(project: LibraryRoot, id: string): Promise<LibraryEntry> {
  return withLibraryLock(project, async () => {
    const listed = await listLibrary(project);
    const current = listed.find((entry) => entry.id === id);
    if (!current) throw new ToolError(`library file not found: ${id}`, "not_found");
    const abs = await jailPath(project.dir, current.path);
    await rm(abs, { force: true });
    const file = await loadLibraryFile(project);
    file.entries = file.entries.filter((entry) => entry.id !== id && entry.path !== current.path);
    file.updatedAt = nowIso();
    await saveLibraryFile(project, file);
    return current;
  });
}

export async function findLibraryEntry(
  project: LibraryRoot,
  id: string,
): Promise<LibraryListedEntry | null> {
  return (await listLibrary(project)).find((entry) => entry.id === id) ?? null;
}

async function withLibraryLock<T>(project: LibraryRoot, run: () => Promise<T>): Promise<T> {
  const key = await libraryManifestPath(project);
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

/** Used by tests that need a fixture file already on disk. */
export async function writeLibraryBytes(project: LibraryRoot, rel: string, data: string | Uint8Array): Promise<string> {
  const abs = await jailPath(project.dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return abs;
}
