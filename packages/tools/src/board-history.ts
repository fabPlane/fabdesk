/** Read any project PCB at a revision, with parsed boards cached by exact content. */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { assertKicadPcbText, boardPadBoxes, boardPartBounds, snapshotFromKicadPcb, type BoardSnapshot } from "@fabdesk/board-diff";
import { isConnectorPart, type BoardFile, type BoardPartStatus, type BoardPartSummary, type BoardRevisionKind, type PartEndpoint } from "@fabdesk/protocol";
import { inspectProjectBoardSources } from "./assembly";
import { exists, jailPath, writeJson } from "./fs";
import { ToolError, type ProjectHandle } from "./registry";
import { assertGitRef, git, gitShow, isGitRepo, projectGitPrefix } from "./tools/board-diff";

export const BOARD_WORKTREE_REF = "worktree";
const SAVED_REF = /^saved:[a-f0-9]{64}$/;
const pointId = (path: string, hash: string) => createHash("sha256").update(`${path}\0${hash}`).digest("hex");
const SAVED_DIRECTORY = ".fabdesk/board-history";
const IGNORED_DIRECTORIES = new Set([".git", ".fabdesk", ".history", "node_modules", "vendor", "exports", "renders", "reports", "placement", "mechanical", "sketches"]);
const MAX_PCB_BYTES = 64 * 1024 * 1024;
const SavedPoint = z.object({
  contract: z.literal("fabplane.board-history-point.v1"),
  path: z.string(), title: z.string(), date: z.string(), sha256: z.string(), kicadPcb: z.string(),
});

export function assertPcbPath(path: string): string {
  const clean = path.trim().replaceAll("\\", "/");
  if (!/\.kicad_pcb$/i.test(clean) || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..")) {
    throw new ToolError(`Choose a .kicad_pcb file inside this project: ${path}`, "invalid_args");
  }
  return clean;
}

/** Line endings are normalized so a Windows checkout matches the same content in git. */
export const boardContentHash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

const snapshotCache = new Map<string, BoardSnapshot>();
const MAX_CACHED_SNAPSHOTS = 48;

function assertBoardText(text: string): void {
  try { assertKicadPcbText(text); }
  catch { throw new ToolError("This PCB is incomplete or invalid. Wait for the file to finish saving, or restore a valid KiCad PCB.", "precondition"); }
}

/** KiCad text is parsed once per content hash, since a timeline revisits the same files. */
export function parseBoard(text: string, hash = boardContentHash(text)): BoardSnapshot {
  const cached = snapshotCache.get(hash);
  if (cached) {
    snapshotCache.delete(hash);
    snapshotCache.set(hash, cached);
    return cached;
  }
  assertBoardText(text);
  const parsed = snapshotFromKicadPcb(text);
  snapshotCache.set(hash, parsed);
  if (snapshotCache.size > MAX_CACHED_SNAPSHOTS) snapshotCache.delete(snapshotCache.keys().next().value!);
  return parsed;
}

async function walkBoards(root: string, rel = "", out: string[] = []): Promise<string[]> {
  const entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.endsWith("-backups")) await walkBoards(root, child, out);
    } else if (entry.isFile() && /\.kicad_pcb$/i.test(entry.name)) out.push(child);
  }
  return out;
}

/** A declared assembly lists exactly its sources; otherwise offer design PCBs, never exported copies. */
export async function listProjectBoards(project: ProjectHandle): Promise<BoardFile[]> {
  const sources = await inspectProjectBoardSources(project);
  const paths = sources.mode === "assembly"
    ? sources.sources.flatMap((row) => (row.status === "available" && row.pcbPath ? [row.pcbPath] : []))
    : await walkBoards(project.dir);
  const boards = await Promise.all(paths.map(async (path): Promise<BoardFile> => {
    const named = sources.mode === "assembly" ? sources.sources.find((row) => row.pcbPath === path)?.source.name : undefined;
    const size = await stat(join(project.dir, path)).catch(() => null);
    return { path, name: named ?? path.split("/").at(-1)!.replace(/\.kicad_pcb$/i, ""), ...(size ? { bytes: size.size } : {}) };
  }));
  return boards.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export type BoardRevision = { ref: string; kind: BoardRevisionKind; title: string; date?: string; text: string; sha256: string };

async function readPcbFile(project: ProjectHandle, path: string): Promise<string> {
  const file = await jailPath(project.dir, path);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ToolError(`No board at ${path}`, "not_found");
  if (info.size > MAX_PCB_BYTES) throw new ToolError(`${path} is too large to compare`, "precondition");
  return readFile(file, "utf8");
}

const exportRef = (path: string) => `export:${path}`;

/** Resolve a revision ref to exact PCB text. `pcbPath` selects the board for git and worktree refs. */
export async function readBoardRevision(project: ProjectHandle, pcbPath: string, ref: string, signal?: AbortSignal): Promise<BoardRevision> {
  const path = assertPcbPath(pcbPath);
  if (ref === BOARD_WORKTREE_REF) {
    const text = await readPcbFile(project, path);
    return { ref, kind: "worktree", title: "Current file", text, sha256: boardContentHash(text) };
  }
  if (SAVED_REF.test(ref)) {
    const point = await readSavedPoint(project, ref.slice(6));
    if (!point) throw new ToolError("This saved point is unavailable. Choose another revision.", "not_found");
    return { ref, kind: "saved", title: point.title, date: point.date, text: point.kicadPcb, sha256: point.sha256 };
  }
  if (ref.startsWith("export:") || ref.startsWith("file:")) {
    const other = assertPcbPath(ref.slice(ref.indexOf(":") + 1));
    const text = await readPcbFile(project, other);
    const date = (await stat(join(project.dir, other)).catch(() => null))?.mtime.toISOString();
    return { ref, kind: "export", title: other, ...(date ? { date } : {}), text, sha256: boardContentHash(text) };
  }
  const clean = assertGitRef(ref);
  if (!(await isGitRepo(project.dir, signal))) throw new ToolError("This project is not a git checkout.", "precondition");
  const prefix = await projectGitPrefix(project.dir, signal);
  const text = await gitShow(project.dir, clean, path, signal, prefix);
  if (text === undefined) throw new ToolError(`${path} does not exist at ${clean}`, "not_found");
  return { ref: clean, kind: "git", title: clean.slice(0, 8), text, sha256: boardContentHash(text) };
}

async function readSavedPoint(project: ProjectHandle, hash: string) {
  const file = await jailPath(project.dir, `${SAVED_DIRECTORY}/${hash}.json`);
  if (!(await exists(file))) return null;
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  const parsed = SavedPoint.safeParse(raw);
  // Saved bytes are re-verified, so an edited point cannot pose as its original revision.
  return parsed.success && (parsed.data.sha256 === hash || pointId(parsed.data.path, parsed.data.sha256) === hash) && boardContentHash(parsed.data.kicadPcb) === parsed.data.sha256 ? parsed.data : null;
}

// HTTP and MCP saves share one daemon. Serialize the read/check/write so a
// simultaneous retry cannot replace the first saved label for the same bytes.
const saveLocks = new Map<string, Promise<unknown>>();

export async function saveBoardPoint(project: ProjectHandle, pcbPath: string, label: string): Promise<{ ref: string; sha256: string; title: string; date: string; created: boolean }> {
  const path = assertPcbPath(pcbPath);
  const key = await jailPath(project.dir, path);
  const run = (saveLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const text = await readPcbFile(project, path), hash = boardContentHash(text);
    assertBoardText(text);
    const id = pointId(path, hash);
    const existing = await readSavedPoint(project, id);
    if (existing) return { ref: `saved:${id}`, sha256: hash, title: existing.title, date: existing.date, created: false };
    const date = new Date().toISOString();
    const file = await jailPath(project.dir, `${SAVED_DIRECTORY}/${id}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeJson(file, { contract: "fabplane.board-history-point.v1", path, title: label, date, sha256: hash, kicadPcb: text });
    return { ref: `saved:${id}`, sha256: hash, title: label, date, created: true };
  });
  saveLocks.set(key, run);
  try { return await run; }
  finally { if (saveLocks.get(key) === run) saveLocks.delete(key); }
}

/** Oldest first, one entry per distinct board content. */
export async function listBoardRevisions(project: ProjectHandle, pcbPath: string, limit: number, signal?: AbortSignal): Promise<{ revisions: BoardRevision[]; git: boolean; truncated: boolean }> {
  const path = assertPcbPath(pcbPath);
  const found: BoardRevision[] = [];
  const savedDirectory = await jailPath(project.dir, SAVED_DIRECTORY);
  for (const name of await readdir(savedDirectory).catch(() => [] as string[])) {
    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    const point = match ? await readSavedPoint(project, match[1]!) : null;
    if (point?.path === path) found.push({ ref: `saved:${match![1]}`, kind: "saved", title: point.title, date: point.date, text: point.kicadPcb, sha256: point.sha256 });
  }
  // Mechanical export bundles carry the exact board copies that were used for that export.
  const exportsDirectory = await jailPath(project.dir, "exports");
  for (const entry of await readdir(exportsDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    for (const folder of ["boards", "source-boards"]) {
      const copy = `exports/${entry.name}/${folder}/${path}`;
      const copyPath = await jailPath(project.dir, copy);
      const info = await stat(copyPath).catch(() => null);
      if (!info?.isFile() || info.size > MAX_PCB_BYTES) continue;
      const text = await readFile(copyPath, "utf8");
      found.push({ ref: exportRef(copy), kind: "export", title: entry.name, date: info.mtime.toISOString(), text, sha256: boardContentHash(text) });
    }
  }
  const isGit = await isGitRepo(project.dir, signal);
  let gitTruncated = false;
  if (isGit) {
    const prefix = await projectGitPrefix(project.dir, signal);
    const log = await git(project.dir, ["log", `-n${limit + 1}`, "--format=%H\t%s\t%cI", "--", path], signal);
    gitTruncated = log.ok && log.stdout.trim().split("\n").length > limit;
    // git lists newest first; keep commits with equal timestamps in their real order.
    for (const line of log.ok ? log.stdout.split("\n").reverse() : []) {
      const [commit, title, date] = line.split("\t");
      if (!commit?.trim()) continue;
      const shown = await gitShow(project.dir, commit, path, signal, prefix);
      if (shown !== undefined) found.push({ ref: commit, kind: "git", title: title || commit.slice(0, 8), ...(date ? { date } : {}), text: shown, sha256: boardContentHash(shown) });
    }
  }
  // Compare instants: git reports local offsets and saved points report UTC.
  const instant = (revision: BoardRevision) => (revision.date ? Date.parse(revision.date) : 0);
  found.sort((a, b) => instant(a) - instant(b));
  const seen = new Set<string>();
  const unique = found.filter((revision) => !seen.has(revision.sha256) && !!seen.add(revision.sha256));
  const worktree = await readBoardRevision(project, path, BOARD_WORKTREE_REF, signal).catch(() => null);
  // The live file is always the newest entry. When it matches earlier revisions it takes the title
  // and date of the latest, preferring a commit, so a revert reads as the revert and not the original.
  const matching = worktree ? found.filter((revision) => revision.sha256 === worktree.sha256) : [];
  const same = matching.filter((revision) => revision.kind === "git").at(-1) ?? matching.at(-1);
  const current = worktree && same ? { ...worktree, title: same.title, ...(same.date ? { date: same.date } : {}) } : worktree;
  const revisions = current ? [...unique.filter((revision) => revision.sha256 !== current.sha256), current] : unique;
  return { revisions: revisions.slice(-limit), git: isGit, truncated: gitTruncated || revisions.length > limit };
}

/** Compact part facts for hit testing and inspection, in the same frame as the drawing. */
export function partSummaries(snapshot: BoardSnapshot, opts: { status?: ReadonlyMap<string, BoardPartStatus>; existing?: boolean; linkedTo?: ReadonlyMap<string, PartEndpoint[]> } = {}): BoardPartSummary[] {
  return snapshot.components.flatMap((component) => {
    const bounds = boardPartBounds(component);
    if (!bounds || component.x === undefined || component.y === undefined) return [];
    return [{
      ref: component.ref,
      ...(component.value ? { value: component.value } : {}),
      ...(component.footprint ? { footprint: component.footprint } : {}),
      ...(component.layer ? { layer: component.layer } : {}),
      x: component.x,
      y: component.y,
      ...(component.rotation !== undefined ? { rotation: component.rotation } : {}),
      bounds,
      nets: [...new Set((component.pads ?? []).flatMap((pad) => (pad.net ? [pad.net] : [])))],
      connector: isConnectorPart(component.ref, component.footprint),
      ...(opts.status?.get(component.ref) ? { status: opts.status.get(component.ref)! } : opts.existing ? { status: "existing" as const } : {}),
      ...(opts.linkedTo?.get(component.ref)?.length ? { linkedTo: opts.linkedTo.get(component.ref)! } : {}),
      pads: boardPadBoxes(component),
    }];
  });
}

