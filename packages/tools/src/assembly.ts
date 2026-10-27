/** Read-only assembly inspection. Membership is declared, never inferred from historical PCB files. */
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ASSEMBLY_MANIFEST_PATH, ProjectAssembly, type AssemblyBoardSource, type ProjectBoardSources } from "@fabdesk/protocol";
import { PROJECT_FILES } from "./fs";
import { ToolError } from "./registry";

type Inspected = ProjectBoardSources["sources"][number];
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const unchanged = (a: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, b: typeof a) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Reject aliases even within the jail: one inode must never become two editable sources. */
async function inspectFile(root: string, relative: string, limit: number, content = false) {
  const path = resolve(root, relative);
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Sources must be regular files");
  if (await realpath(path) !== path) throw new Error("Symbolic links are not independent board sources");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!unchanged(entry, before) || await realpath(path) !== path) throw new Error("Source changed before inspection");
    if (!before.isFile() || before.nlink !== 1) throw new Error("Board sources must be regular files without hard-link aliases");
    if (before.size > limit) throw new Error("Source exceeds the inspection size limit");
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) throw new Error("Source exceeds the inspection size limit");
      hash.update(buffer);
      if (content) chunks.push(buffer);
    }
    const after = await file.stat(), current = await lstat(path);
    if (!unchanged(before, after) || !unchanged(after, current) || await realpath(path) !== path) throw new Error("Source changed during inspection; inspect again");
    return { identity: `${before.dev}:${before.ino}`, sha256: hash.digest("hex"), bytes, text: content ? Buffer.concat(chunks).toString("utf8") : null };
  } finally { await file.close(); }
}

async function inspectSource(root: string, source: AssemblyBoardSource, identities: Map<string, string[]>): Promise<Inspected> {
  if (source.location === "unresolved") return { source, status: "unresolved", reason: "Resolve this source into the project before opening its board" };
  const prefix = source.directory === "." ? "" : `${source.directory}/`;
  const pcbPath = `${prefix}${PROJECT_FILES.boardPcb}`;
  try {
    const info = await inspectFile(root, pcbPath, 512 * 1024 * 1024);
    const owners = identities.get(info.identity) ?? [];
    owners.push(source.id);
    identities.set(info.identity, owners);
    // Only the canonical source is ownership evidence. Optional preview/schematic references
    // carry no freshness, ERC, netlist-parity or compatibility claim.
    const optional: { schematicPath?: string; previewPath?: string } = {};
    for (const [key, relative] of [["schematicPath", `${prefix}${PROJECT_FILES.boardSch}`], ["previewPath", `${prefix}renders/pcb.svg`]] as const) {
      try {
        const path = resolve(root, relative), st = await lstat(path);
        if (st.isFile() && st.nlink === 1 && await realpath(path) === path) optional[key] = relative;
      } catch { /* An absent or unsafe optional artifact cannot establish source ownership. */ }
    }
    return { source, status: "available", pcbPath, pcbSha256: info.sha256, bytes: info.bytes, ...optional };
  } catch (error) {
    return { source, status: isMissing(error) ? "missing" : "blocked", reason: isMissing(error) ? "Canonical board.kicad_pcb is missing from this source directory" : "Source ownership could not be verified. Remove file aliases or retry after editing has stopped." };
  }
}

/** No writes, downloads, migrations, adoption, native KiCad sessions or agent calls. */
export async function inspectProjectBoardSources(project: { id: string; dir: string }): Promise<ProjectBoardSources> {
  const root = await realpath(project.dir);
  let manifest: Awaited<ReturnType<typeof inspectFile>> | null = null;
  try { manifest = await inspectFile(root, ASSEMBLY_MANIFEST_PATH, 512 * 1024, true); }
  catch (error) {
    if (!isMissing(error)) throw new ToolError("Assembly manifest could not be safely read. Use a regular project-owned fabplane.assembly.json file under 512 KiB.", "invalid_args");
  }
  let assembly: ProjectAssembly | null = null;
  if (manifest) {
    try { assembly = ProjectAssembly.parse(JSON.parse(manifest.text!)); }
    catch { throw new ToolError("Invalid fabplane.assembly.json. Declare unique source directories, physical instances and connection endpoints using fabplane.assembly.v1.", "invalid_args"); }
  }
  const declared: AssemblyBoardSource[] = assembly?.sources ?? [{ id: "main", name: "Main board", location: "project", directory: "." }];
  // Bound simultaneous hashes; large native boards must not be read wholesale into memory.
  const sources: Inspected[] = new Array(declared.length);
  const identities = new Map<string, string[]>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, declared.length) }, async () => {
    for (;;) { const index = next++; const source = declared[index]; if (!source) break; sources[index] = await inspectSource(root, source, identities); }
  }));
  const aliased = new Set([...identities.values()].filter(owners => owners.length > 1).flat());
  sources.forEach((record, index) => {
    if (aliased.has(record.source.id)) sources[index] = { source: record.source, status: "blocked", reason: "Two source declarations resolve to the same file. Declare one source and use repeated instances." };
  });
  try {
    const current = await inspectFile(root, ASSEMBLY_MANIFEST_PATH, 512 * 1024);
    if (current.sha256 !== manifest?.sha256) throw new Error("changed");
  } catch (error) {
    if (manifest || !isMissing(error)) throw new ToolError("Assembly membership changed during inspection; inspect again.", "invalid_args");
  }
  return { projectId: project.id, mode: assembly ? "assembly" : "single", assembly, manifestSha256: manifest?.sha256 ?? null, sources, observedAt: new Date().toISOString(), editing: assembly ? "explicit-source-tools" : "single-board-only" };
}
