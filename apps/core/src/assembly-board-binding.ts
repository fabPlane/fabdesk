/** Captured assembly ownership for one native operation. A source selector is never a global active-board switch. */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ASSEMBLY_MANIFEST_PATH } from "@fabdesk/protocol";
import { inspectProjectBoardSources, NativeRevisionConflict, ToolError } from "@fabdesk/tools";

export type AssemblyBoardSelector = { sourceId: string; manifestSha256: string };
export type NativeBoardBinding = Readonly<{
  projectId: string;
  sourceId: string;
  manifestSha256: string;
  rootDir: string;
  boardDir: string;
  assertCurrent(dir: string): Promise<void>;
}>;
const currentBinding = new AsyncLocalStorage<NativeBoardBinding>();

async function manifestHash(root: string): Promise<string> {
  const path = resolve(root, ASSEMBLY_MANIFEST_PATH);
  if (await realpath(path) !== path) throw new Error("Manifest is aliased");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 512 * 1024) throw new Error("Manifest is not independently owned");
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > 512 * 1024) throw new Error("Manifest is oversized");
      hash.update(chunk);
    }
    const after = await file.stat(), pathStat = await lstat(path);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.ino !== pathStat.ino || after.dev !== pathStat.dev || after.size !== pathStat.size || after.mtimeMs !== pathStat.mtimeMs || after.ctimeMs !== pathStat.ctimeMs || await realpath(path) !== path) throw new Error("Manifest changed during inspection");
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** Resolves only a declared, independently owned source at the caller's captured manifest revision. */
export async function resolveNativeBoardBinding(project: { id: string; dir: string }, selector: AssemblyBoardSelector): Promise<NativeBoardBinding> {
  const capturedProject = { id: project.id, dir: project.dir };
  const sourceId = selector.sourceId, manifestSha256 = selector.manifestSha256;
  const inspection = await inspectProjectBoardSources(capturedProject);
  if (inspection.mode !== "assembly" || inspection.manifestSha256 !== manifestSha256) throw new NativeRevisionConflict("Assembly membership changed. Reload the overview and select the board again.");
  const member = inspection.sources.find(row => row.source.id === sourceId);
  if (!member || member.source.location !== "project" || member.status !== "available") throw new ToolError("This board source is missing, unresolved or not independently owned. Resolve its project files before opening it.", "precondition");
  const rootDir = await realpath(capturedProject.dir), root = await stat(rootDir);
  const boardDir = resolve(rootDir, member.source.directory), boardDirectory = await stat(boardDir);
  const binding: NativeBoardBinding = Object.freeze({
    projectId: capturedProject.id, sourceId, manifestSha256, rootDir, boardDir,
    async assertCurrent(dir: string) {
      try {
        const currentRoot = await stat(rootDir);
        if (await realpath(capturedProject.dir) !== rootDir || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || !currentRoot.isDirectory()) throw new Error("Project root changed");
        const currentBoardDirectory = await stat(boardDir);
        if (resolve(dir) !== boardDir || await realpath(boardDir) !== boardDir || currentBoardDirectory.dev !== boardDirectory.dev || currentBoardDirectory.ino !== boardDirectory.ino) throw new Error("Board directory changed");
        if (await manifestHash(rootDir) !== manifestSha256) throw new Error("Membership changed");
        for (const filename of ["board.kicad_pcb", "board.kicad_sch", "board.kicad_pro", "fp-lib-table", "sym-lib-table"]) {
          const path = resolve(boardDir, filename);
          const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (filename !== "board.kicad_pcb" && error.code === "ENOENT") return null;
            throw error;
          });
          if (metadata && (!metadata.isFile() || metadata.nlink !== 1 || await realpath(path) !== path)) throw new Error("Native source or companion file is aliased");
        }
      } catch {
        throw new NativeRevisionConflict("Assembly board ownership changed or could not be verified. No new save is allowed; reload the overview and select the source again.");
      }
    },
  });
  await binding.assertCurrent(boardDir);
  return binding;
}

/** Async-local scopes keep concurrent source jobs isolated and restore an outer scope on exit. */
export async function withNativeBoardBinding<T>(binding: NativeBoardBinding, operation: () => Promise<T>): Promise<T> {
  await binding.assertCurrent(binding.boardDir);
  return currentBinding.run(binding, operation);
}

/** Called at native entry and immediately before save; unscoped legacy operations are unchanged. */
export async function assertNativeBoardOwnership(dir: string): Promise<void> {
  await currentBinding.getStore()?.assertCurrent(dir);
}
