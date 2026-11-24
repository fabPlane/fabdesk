/** Content-addressed project checkpoints and an atomic accepted-revision pointer. */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withoutAppImageRuntime } from "./appimage-env";

const EXCLUDED_DIRECTORIES = new Set([
  ".fabdesk",
  ".git",
  "exports",
  "reports",
  "renders",
  "node_modules",
]);
const INTERNAL_ROOT = ".fabdesk/revisions";

type ManifestEntry = { path: string; bytes: number; sha256: string };
type RevisionManifest = {
  contract: { name: "fabdesk.project-revision"; version: "1.0.0" };
  revision: string;
  capturedAt: string;
  label: string | null;
  files: ManifestEntry[];
};
type Validation = {
  structural: "pass";
  evidenceLevel: "measured";
  toolchain: { kicadCli: string; version: string };
  checks: Array<{ artifact: string; status: "pass" | "inapplicable"; detail: string }>;
};
type AcceptedPointer = {
  contract: { name: "fabdesk.accepted-revision"; version: "1.0.0" };
  revision: string;
  acceptedAt: string;
  validation: Validation;
};

export type ProjectRevisionOptions = {
  action?: "status" | "checkpoint" | "accept" | "discard";
  project?: string;
  label?: string;
};

type RevisionDeps = {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  validate?: (project: string, env: NodeJS.ProcessEnv) => Promise<Validation>;
  out?: (text: string) => void;
  err?: (text: string) => void;
};

export const PROJECT_REVISION_USAGE = `Usage:
  fabpcb revision status [--project <dir>]
  fabpcb revision checkpoint [--project <dir>] [--label <text>]
  fabpcb revision accept [--project <dir>] [--label <text>]
  fabpcb revision discard [--project <dir>]

Checkpoint records a content-addressed snapshot without changing the accepted revision. Accept
first proves that present native KiCad artifacts reopen with the packaged toolchain, then advances
one atomic pointer. It does not require ERC or DRC success. Discard restores the accepted snapshot
and preserves displaced candidate files under .fabdesk/revisions/recovery/.
`;

function ignoredFile(name: string): boolean {
  return (
    name.startsWith("~") ||
    name.endsWith(".lck") ||
    name.endsWith(".bak") ||
    name.endsWith(".kicad_prl")
  );
}

async function projectFiles(root: string, directory = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(
        `project snapshots do not follow symbolic links: ${relative(root, join(directory, entry.name))}`,
      );
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name))
        output.push(...(await projectFiles(root, join(directory, entry.name))));
      continue;
    }
    if (entry.isFile() && !ignoredFile(entry.name))
      output.push(relative(root, join(directory, entry.name)));
  }
  return output.sort();
}

async function fileEntry(root: string, path: string): Promise<ManifestEntry> {
  const body = await readFile(join(root, path));
  return { path, bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
}

async function manifestEntries(project: string): Promise<ManifestEntry[]> {
  return Promise.all((await projectFiles(project)).map((path) => fileEntry(project, path)));
}

function revisionOf(files: ManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return hash.digest("hex");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function snapshot(project: string, label: string | undefined): Promise<RevisionManifest> {
  const root = join(project, INTERNAL_ROOT);
  const staging = join(root, `.staging-${randomUUID()}`);
  try {
    const paths = await projectFiles(project);
    for (const path of paths) {
      const target = join(staging, "files", path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(project, path), target);
    }
    const files = await Promise.all(paths.map((path) => fileEntry(join(staging, "files"), path)));
    const revision = revisionOf(files);
    const destination = join(root, revision);
    const existing = await readJson<RevisionManifest>(join(destination, "manifest.json"));
    if (existing) {
      await rm(staging, { recursive: true, force: true });
      return existing;
    }
    const manifest: RevisionManifest = {
      contract: { name: "fabdesk.project-revision", version: "1.0.0" },
      revision,
      capturedAt: new Date().toISOString(),
      label: label?.trim() || null,
      files,
    };
    await atomicJson(join(staging, "manifest.json"), manifest);
    await mkdir(root, { recursive: true });
    await rename(staging, destination).catch(async (error) => {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      await rm(staging, { recursive: true, force: true });
    });
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function spawn(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(withoutAppImageRuntime(options.env)))
    if (typeof value === "string") env[key] = value;
  const child = Bun.spawn(command, {
    windowsHide: true,
    cwd: options.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `${basename(command[0]!)} ${command.slice(1, 4).join(" ")} failed (${exitCode}): ${(stderr || stdout).trim().split("\n").slice(-4).join(" | ")}`,
    );
  return (stdout || stderr).trim();
}

async function validateNative(project: string, env: NodeJS.ProcessEnv): Promise<Validation> {
  const cli = env["KICAD_CLI"]?.trim();
  if (!cli || !isAbsolute(cli))
    throw new Error("KICAD_CLI must identify the absolute packaged executable");
  const metadata = await stat(cli).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`packaged KICAD_CLI does not exist: ${cli}`);
  const version = await spawn([cli, "--version"], { cwd: project, env });
  const artifacts = new Set(await projectFiles(project));
  const pro = "board.kicad_pro",
    schematic = "board.kicad_sch",
    board = "board.kicad_pcb";
  if (!artifacts.has(schematic) && !artifacts.has(board))
    throw new Error("candidate has neither board.kicad_sch nor board.kicad_pcb");
  const checks: Validation["checks"] = [];
  if (artifacts.has(pro)) {
    JSON.parse(await readFile(join(project, pro), "utf8"));
    checks.push({ artifact: pro, status: "pass", detail: "valid JSON" });
  } else checks.push({ artifact: pro, status: "inapplicable", detail: "not present" });
  const scratch = await mkdtemp(join(tmpdir(), "fabdesk-native-validation-"));
  try {
    if (artifacts.has(schematic)) {
      await mkdir(join(scratch, "schematic"), { recursive: true });
      await spawn(
        [
          cli,
          "sch",
          "export",
          "svg",
          "-o",
          `${join(scratch, "schematic")}${sep}`,
          join(project, schematic),
        ],
        { cwd: project, env },
      );
      checks.push({
        artifact: schematic,
        status: "pass",
        detail: "reopened and exported by packaged KiCad",
      });
    } else checks.push({ artifact: schematic, status: "inapplicable", detail: "not present" });
    if (artifacts.has(board)) {
      await spawn(
        [
          cli,
          "pcb",
          "export",
          "svg",
          "--layers",
          "F.Cu,B.Cu,F.SilkS,B.SilkS,Edge.Cuts",
          "--exclude-drawing-sheet",
          "--page-size-mode",
          "2",
          "--mode-single",
          "-o",
          join(scratch, "board.svg"),
          join(project, board),
        ],
        { cwd: project, env },
      );
      checks.push({
        artifact: board,
        status: "pass",
        detail: "reopened and exported by packaged KiCad",
      });
    } else checks.push({ artifact: board, status: "inapplicable", detail: "not present" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return {
    structural: "pass",
    evidenceLevel: "measured",
    toolchain: { kicadCli: cli, version },
    checks,
  };
}

async function acceptedPointer(project: string): Promise<AcceptedPointer | null> {
  return readJson<AcceptedPointer>(join(project, INTERNAL_ROOT, "accepted.json"));
}

function compare(current: ManifestEntry[], accepted: ManifestEntry[]) {
  const now = new Map(current.map((file) => [file.path, file]));
  const before = new Map(accepted.map((file) => [file.path, file]));
  return {
    added: current.filter((file) => !before.has(file.path)).map((file) => file.path),
    modified: current
      .filter((file) => before.has(file.path) && before.get(file.path)!.sha256 !== file.sha256)
      .map((file) => file.path),
    removed: accepted.filter((file) => !now.has(file.path)).map((file) => file.path),
  };
}

export async function inspectProjectRevision(project: string): Promise<{
  project: string;
  accepted: string | null;
  current: string;
  clean: boolean;
  changes: { added: string[]; modified: string[]; removed: string[] };
}> {
  const resolved = resolve(project);
  const currentFiles = await manifestEntries(resolved);
  const current = revisionOf(currentFiles);
  const pointer = await acceptedPointer(resolved);
  if (!pointer)
    return {
      project: resolved,
      accepted: null,
      current,
      clean: false,
      changes: { added: [], modified: [], removed: [] },
    };
  const manifest = await readJson<RevisionManifest>(
    join(resolved, INTERNAL_ROOT, pointer.revision, "manifest.json"),
  );
  if (!manifest || manifest.revision !== pointer.revision)
    throw new Error(`accepted snapshot is missing or invalid: ${pointer.revision}`);
  const changes = compare(currentFiles, manifest.files);
  return {
    project: resolved,
    accepted: pointer.revision,
    current,
    clean: !changes.added.length && !changes.modified.length && !changes.removed.length,
    changes,
  };
}

async function withLock<T>(project: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(project, INTERNAL_ROOT, "mutation.lock");
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("another revision mutation is in progress");
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function restore(
  project: string,
  manifest: RevisionManifest,
  recoveryDirectory: string,
): Promise<void> {
  const current = await manifestEntries(project);
  const targetPaths = new Set(manifest.files.map((file) => file.path));
  for (const file of current) {
    if (targetPaths.has(file.path)) continue;
    const recovery = join(recoveryDirectory, file.path);
    await mkdir(dirname(recovery), { recursive: true });
    await rename(join(project, file.path), recovery);
  }
  for (const file of manifest.files) {
    const source = join(project, INTERNAL_ROOT, manifest.revision, "files", file.path);
    const target = join(project, file.path);
    const temporary = `${target}.restore-${randomUUID()}`;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, temporary);
    await rename(temporary, target);
  }
  const restored = await manifestEntries(project);
  if (revisionOf(restored) !== manifest.revision)
    throw new Error("restored files do not match the accepted revision");
}

export async function runProjectRevision(
  options: ProjectRevisionOptions,
  deps: RevisionDeps = {},
): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const base = (deps.cwd ?? process.cwd)();
  const project = resolve(base, options.project ?? ".");
  const action = options.action ?? "status";
  const projectMetadata = await stat(project).catch(() => null);
  if (!projectMetadata?.isDirectory()) {
    err(`fabpcb revision: project directory does not exist: ${project}\n`);
    return 1;
  }
  try {
    if (action === "checkpoint") {
      const captured = await snapshot(project, options.label);
      out(
        `${JSON.stringify({ status: "checkpointed", project, revision: captured.revision, files: captured.files.length }, null, 2)}\n`,
      );
      return 0;
    }
    if (action === "accept")
      return await withLock(project, async () => {
        const candidateRevision = revisionOf(await manifestEntries(project));
        const validation = await (deps.validate ?? validateNative)(
          project,
          deps.env ?? process.env,
        );
        const captured = await snapshot(project, options.label);
        const currentRevision = revisionOf(await manifestEntries(project));
        if (captured.revision !== candidateRevision || currentRevision !== candidateRevision)
          throw new Error(
            "candidate files changed during validation or snapshot; accepted pointer was not advanced",
          );
        const pointer: AcceptedPointer = {
          contract: { name: "fabdesk.accepted-revision", version: "1.0.0" },
          revision: captured.revision,
          acceptedAt: new Date().toISOString(),
          validation,
        };
        await atomicJson(join(project, INTERNAL_ROOT, "accepted.json"), pointer);
        out(
          `${JSON.stringify({ status: "accepted", project, revision: captured.revision, files: captured.files.length, validation }, null, 2)}\n`,
        );
        return 0;
      });

    const accepted = await acceptedPointer(project);
    if (!accepted) throw new Error("no accepted project revision exists");
    const manifest = await readJson<RevisionManifest>(
      join(project, INTERNAL_ROOT, accepted.revision, "manifest.json"),
    );
    if (!manifest || manifest.revision !== accepted.revision)
      throw new Error(`accepted snapshot is missing or invalid: ${accepted.revision}`);
    if (action === "status") {
      const state = await inspectProjectRevision(project);
      out(`${JSON.stringify({ status: state.clean ? "clean" : "changed", ...state }, null, 2)}\n`);
      return state.clean ? 0 : 1;
    }
    if (action === "discard")
      return await withLock(project, async () => {
        const recovery = await snapshot(project, "automatic recovery before discard");
        const recoveryDirectory = join(
          project,
          INTERNAL_ROOT,
          "recovery",
          new Date().toISOString().replace(/[:.]/g, "-"),
        );
        try {
          await restore(project, manifest, recoveryDirectory);
        } catch (error) {
          const rollbackDirectory = join(
            project,
            INTERNAL_ROOT,
            "recovery",
            `failed-discard-${randomUUID()}`,
          );
          await restore(project, recovery, rollbackDirectory).catch(() => undefined);
          throw error;
        }
        out(
          `${JSON.stringify({ status: "discarded", project, restored: accepted.revision, recoveryRevision: recovery.revision, displacedFiles: relative(project, recoveryDirectory) }, null, 2)}\n`,
        );
        return 0;
      });
    throw new Error(`unknown revision action: ${action}\n${PROJECT_REVISION_USAGE}`);
  } catch (error) {
    err(`fabpcb revision: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
