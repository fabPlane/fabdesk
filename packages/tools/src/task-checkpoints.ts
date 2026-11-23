/** Saved native checkpoints and guarded recovery; no native check or inferred acceptance. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { jailPath, projectRelative, writeJson } from "./fs";
import { ToolError, type ProjectHandle } from "./registry";
import { kicadString } from "./kicad-string";

type Node = string | Node[];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const ROOT = ".fabdesk/task-checkpoints";
const MAX_FILES = 500;
// Real boards are large (an 85 MB PCB with its sheets); file contents are stored once by hash, so checkpoints of
// an unchanged schematic set cost nothing after the first.
const MAX_BYTES = 1024 * 1024 * 1024;
const BLOBS = `${ROOT}/blobs`;
export const TaskScope = z.object({
  nets: z.array(z.string().min(1)).max(500).default([]),
  references: z.array(z.string().min(1)).max(500).default([]),
});
const FileIdentity = z.object({
  path: z.string(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  bytes: z.number().int().min(0).max(MAX_BYTES).nullable(),
});
const Manifest = z.object({
  version: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  reason: z.string(),
  role: z.enum(["baseline", "checkpoint"]),
  createdAt: z.string(),
  revision: z.string(),
  scope: TaskScope.nullable(),
  files: z.array(FileIdentity).min(1).max(MAX_FILES),
  runtimeId: z.string().nullable(),
  validation: z.object({ designChecksRun: z.literal(false), taskAccepted: z.literal(false) }),
});
export type TaskCheckpoint = z.infer<typeof Manifest>;
type Captured = { path: string; data: Buffer | null; sha256: string | null; bytes: number | null };

/** Captures native project inputs, including child sheets/rules/tables; runtime artifacts are excluded. */
async function nativePaths(project: ProjectHandle) {
  const paths = new Set([
    "board.kicad_pcb",
    "board.kicad_sch",
    "board.kicad_pro",
    "board.kicad_dru",
    "fp-lib-table",
    "sym-lib-table",
  ]);
  let visited = 0;
  const walk = async (relative: string) => {
    const dir = relative ? await jailPath(project.dir, relative) : project.dir;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited > 10_000)
        throw new ToolError("native checkpoint directory scan exceeds limit", "precondition");
      if (
        [".git", ".fabdesk", "node_modules", "reports", "renders", "exports", "releases"].includes(
          entry.name,
        )
      )
        continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (
        /\.(kicad_pcb|kicad_sch|kicad_pro|kicad_dru)$/.test(entry.name) ||
        ["fp-lib-table", "sym-lib-table"].includes(entry.name)
      ) {
        if (entry.isSymbolicLink())
          throw new ToolError(`native checkpoint refuses symlink: ${path}`, "precondition");
        paths.add(path);
      }
      if (paths.size > MAX_FILES)
        throw new ToolError("native checkpoint file count exceeds limit", "precondition");
    }
  };
  await walk("");
  return [...paths].sort();
}
async function capture(project: ProjectHandle, keep = true): Promise<Captured[]> {
  const result: Captured[] = [];
  let bytes = 0;
  for (const path of await nativePaths(project)) {
    const data = await readFile(await jailPath(project.dir, path)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    bytes += data?.length ?? 0;
    if (bytes > MAX_BYTES)
      throw new ToolError("native checkpoint size exceeds limit", "precondition");
    // observation-only captures keep identities, not bytes (a large board would otherwise be held several times)
    result.push({ path, data: keep ? data : data && Buffer.alloc(0), sha256: data ? digest(data) : null, bytes: data?.length ?? null });
  }
  return result;
}
const identities = (files: Captured[]) =>
  files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
const revision = (files: z.infer<typeof FileIdentity>[]) => digest(JSON.stringify(files));
async function stableCapture(project: ProjectHandle) {
  const first = await capture(project),
    second = await capture(project, false);
  if (revision(identities(first)) !== revision(identities(second)))
    throw new ToolError(
      "native files changed during checkpoint observation; retry",
      "precondition",
    );
  return first;
}
async function root(project: ProjectHandle) {
  return jailPath(project.dir, ROOT);
}

async function nativeTarget(project: ProjectHandle, path: string) {
  const target = await jailPath(project.dir, path);
  if (
    projectRelative(project.dir, target) !== path ||
    path
      .split("/")
      .some((part) =>
        [".git", ".fabdesk", "node_modules", "reports", "renders", "exports", "releases"].includes(
          part,
        ),
      ) ||
    !(
      /\.(kicad_pcb|kicad_sch|kicad_pro|kicad_dru)$/.test(path) ||
      ["fp-lib-table", "sym-lib-table"].includes(path.split("/").at(-1)!)
    )
  )
    throw new ToolError(`unsafe native checkpoint path: ${path}`, "precondition");
  // Reject even in-project aliases: restoring one must not overwrite a different native input.
  let probe = target;
  while (probe !== project.dir) {
    const stat = await lstat(probe).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink() || (probe === target && stat && !stat.isFile()))
      throw new ToolError(`native checkpoint refuses non-file/symlink: ${path}`, "precondition");
    probe = dirname(probe);
  }
  return target;
}

async function checkpointFiles(
  project: ProjectHandle,
  checkpoint: TaskCheckpoint,
): Promise<Captured[]> {
  const saved: Captured[] = [],
    seen = new Set<string>();
  let total = 0;
  for (const file of checkpoint.files) {
    await nativeTarget(project, file.path);
    if (seen.has(file.path) || (file.sha256 === null) !== (file.bytes === null))
      throw new ToolError(`invalid checkpoint file identity: ${file.path}`, "precondition");
    seen.add(file.path);
    total += file.bytes ?? 0;
    if (total > MAX_BYTES)
      throw new ToolError("native checkpoint size exceeds limit", "precondition");
    const data =
      file.sha256 === null
        ? null
        : await readFile(
            await jailPath(project.dir, `${ROOT}/${checkpoint.id}/files/${file.path}`),
          ).catch(() => null);
    if ((data ? digest(data) : null) !== file.sha256 || (data?.length ?? null) !== file.bytes)
      throw new ToolError(`task checkpoint bytes no longer match: ${file.path}`, "precondition");
    saved.push({ ...file, data });
  }
  return saved;
}

async function withCheckpointLock<T>(project: ProjectHandle, run: () => Promise<T>): Promise<T> {
  await mkdir(await root(project), { recursive: true });
  const lock = await jailPath(project.dir, `${ROOT}/capture.lock`);
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ToolError("another checkpoint capture or restore is active", "precondition");
    throw error;
  }
  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function listTaskCheckpoints(project: ProjectHandle): Promise<TaskCheckpoint[]> {
  const directory = await root(project);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result: TaskCheckpoint[] = [];
  for (const name of names.filter((name) => /^task-[a-z0-9-]+$/.test(name)).sort()) {
    const path = await jailPath(project.dir, `${ROOT}/${name}/manifest.json`);
    const parsed = Manifest.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success)
      throw new ToolError(`invalid task checkpoint manifest: ${name}`, "precondition");
    const checkpoint = parsed.data;
    if (
      checkpoint.id !== name ||
      checkpoint.projectId !== project.id ||
      checkpoint.revision !== revision(checkpoint.files)
    )
      throw new ToolError(`task checkpoint identity mismatch: ${name}`, "precondition");
    result.push(checkpoint);
  }
  if (result.filter((value) => value.role === "baseline").length > 1)
    throw new ToolError("multiple task baselines; refusing ambiguous comparison", "precondition");
  return result;
}

export async function retainTaskCheckpoint(
  project: ProjectHandle,
  input: {
    name: string;
    reason: string;
    role: "baseline" | "checkpoint";
    scope?: z.infer<typeof TaskScope>;
  },
  runtimeId: string | null,
) {
  return withCheckpointLock(project, () => retainUnlocked(project, input, runtimeId));
}

async function retainUnlocked(
  project: ProjectHandle,
  input: {
    name: string;
    reason: string;
    role: "baseline" | "checkpoint";
    scope?: z.infer<typeof TaskScope>;
  },
  runtimeId: string | null,
) {
  const id = `task-${Date.now().toString(36)}-${randomUUID()}`;
  const temporary = await jailPath(project.dir, `${ROOT}/.pending-${id}`);
  try {
    const previous = await listTaskCheckpoints(project);
    if (input.role === "baseline" && previous.some((value) => value.role === "baseline"))
      throw new ToolError(
        "task baseline already retained; use a separate project/task instead of silently replacing scope",
        "precondition",
      );
    const files = await stableCapture(project);
    const manifest: TaskCheckpoint = {
      version: 1,
      id,
      projectId: project.id,
      name: input.name,
      reason: input.reason,
      role: input.role,
      createdAt: new Date().toISOString(),
      revision: revision(identities(files)),
      scope: input.scope
        ? {
            nets: [...new Set(input.scope.nets)].sort(),
            references: [...new Set(input.scope.references)].sort(),
          }
        : null,
      files: identities(files),
      runtimeId,
      validation: { designChecksRun: false, taskAccepted: false },
    };
    await mkdir(temporary);
    await mkdir(await jailPath(project.dir, BLOBS), { recursive: true });
    for (const file of files)
      if (file.data !== null && file.sha256) {
        // each checkpoint keeps its own files/<path>; the bytes are a hardlink to one blob per content, reused
        // only after its hash is checked again (a tampered copy never seeds a later checkpoint)
        const blob = await jailPath(project.dir, `${BLOBS}/${file.sha256}`);
        const current = await readFile(blob).catch(() => null);
        if (!current || digest(current) !== file.sha256) {
          const part = `${blob}.part-${id}`;
          await writeFile(part, file.data, { flag: "wx" });
          await rename(part, blob);
        }
        const path = await jailPath(project.dir, `${ROOT}/.pending-${id}/files/${file.path}`);
        await mkdir(join(path, ".."), { recursive: true });
        await link(blob, path).catch(() => writeFile(path, file.data!, { flag: "wx" }));
      }
    // Reject changed file sets/content before exposing any checkpoint as retained.
    if (manifest.revision !== revision(identities(await capture(project, false))))
      throw new ToolError(
        "native files changed before checkpoint publication; retry",
        "precondition",
      );
    await writeJson(join(temporary, "manifest.json"), manifest);
    await rename(temporary, await jailPath(project.dir, `${ROOT}/${id}`));
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Explicit saved-file restore; the runtime must preserve unsaved state and quiesce its session. */
export async function restoreTaskCheckpoint(
  project: ProjectHandle,
  checkpointId: string,
  expectedRevision: string,
  reason: string,
  runtimeId: string | null,
  recover: <T>(replace: () => Promise<T>) => Promise<T>,
) {
  return withCheckpointLock(project, async () => {
    const checkpoint = (await listTaskCheckpoints(project)).find(
      (value) => value.id === checkpointId,
    );
    if (!checkpoint) throw new ToolError("task checkpoint not found", "not_found");
    const saved = await checkpointFiles(project, checkpoint);
    if (revision(identities(await stableCapture(project))) !== expectedRevision)
      throw new ToolError(
        "native files changed since comparison; refusing stale checkpoint restore",
        "precondition",
      );
    return recover(async () => {
      const current = await stableCapture(project);
      if (revision(identities(current)) !== expectedRevision)
        throw new ToolError(
          "native files changed before restore; refusing stale checkpoint restore",
          "precondition",
        );
      const displaced = await retainUnlocked(
        project,
        { name: `Before restoring ${checkpoint.name}`.slice(0, 100), reason, role: "checkpoint" },
        runtimeId,
      );
      const savedByPath = new Map(saved.map((file) => [file.path, file]));
      const currentByPath = new Map(current.map((file) => [file.path, file]));
      const paths = [...new Set([...savedByPath.keys(), ...currentByPath.keys()])].sort();
      // Validate all destinations before replacing any file. Extra native files created after
      // capture are removed, with their bytes retained in the displaced checkpoint.
      for (const path of paths) await nativeTarget(project, path);
      const restoreId = `restore-${randomUUID()}`;
      const journalPath = `${ROOT}/restores/${restoreId}.json`;
      const journal = {
        restoreId,
        checkpointId,
        displacedCheckpointId: displaced.id,
        expectedRevision,
        targetRevision: checkpoint.revision,
        reason,
        startedAt: new Date().toISOString(),
        status: "prepared",
        completedPaths: [] as string[],
      };
      const staged = new Map<string, string>();
      try {
        for (const path of paths) {
          const data = savedByPath.get(path)?.data;
          if (data === null || data === undefined) continue;
          const temporary = await jailPath(
            project.dir,
            `${ROOT}/restores/${restoreId}/files/${path}`,
          );
          await mkdir(dirname(temporary), { recursive: true });
          await writeFile(temporary, data, { flag: "wx" });
          if (digest(await readFile(temporary)) !== digest(data))
            throw new ToolError(`restore staging failed: ${path}`, "internal");
          staged.set(path, temporary);
        }
        await writeJson(await jailPath(project.dir, journalPath), journal);
        if (revision(identities(await stableCapture(project))) !== expectedRevision)
          throw new ToolError(
            "native files changed during restore staging; no files replaced",
            "precondition",
          );
        for (const path of paths) {
          const target = await nativeTarget(project, path);
          const before = await readFile(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if ((before ? digest(before) : null) !== (currentByPath.get(path)?.sha256 ?? null))
            throw new ToolError(`native file changed during restore: ${path}`, "precondition");
          const temporary = staged.get(path);
          if (temporary) {
            await mkdir(dirname(target), { recursive: true });
            await rename(temporary, target);
            staged.delete(path);
          } else await rm(target, { force: true });
          journal.completedPaths.push(path);
          journal.status = "replacing";
          await writeJson(await jailPath(project.dir, journalPath), journal);
        }
        const restored = await stableCapture(project);
        if (revision(identities(restored)) !== checkpoint.revision)
          throw new ToolError("restored native file set differs from checkpoint", "precondition");
        journal.status = "restored";
        await writeJson(await jailPath(project.dir, journalPath), journal);
        return {
          status: "restored",
          checkpointId,
          displacedCheckpointId: displaced.id,
          beforeRevision: expectedRevision,
          restoredRevision: checkpoint.revision,
          restoredFiles: paths.length,
          journal: journalPath,
          validation: { designChecksRun: false, taskAccepted: false },
          limits:
            "captured saved native files only; unsaved conflicts are refused; arbitrary external writers are not atomically excluded; release evidence must be checked against restored revisions",
        };
      } catch (error) {
        journal.status = journal.completedPaths.length ? "partial" : "refused";
        await writeJson(await jailPath(project.dir, journalPath), {
          ...journal,
          error: String(error),
        });
        // Never automatically roll back over a racing external writer. Both retained saved
        // versions and the journal give a deliberate recovery path.
        throw new ToolError(
          `checkpoint restore ${journal.status}; ${journal.completedPaths.length} file(s) replaced. Target ${checkpointId}, displaced ${displaced.id}, journal ${journalPath}. ${String(error)}`,
          "precondition",
        );
      } finally {
        await rm(await jailPath(project.dir, `${ROOT}/restores/${restoreId}`), {
          recursive: true,
          force: true,
        });
      }
    });
  });
}

function parsePcb(text: string): Node[] {
  const stack: Node[][] = [[]];
  for (const token of text.match(/\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+/g) ?? []) {
    if (token === "(") {
      const n: Node[] = [];
      stack.at(-1)!.push(n);
      stack.push(n);
    } else if (token === ")") {
      if (stack.length < 2) throw new ToolError("invalid saved PCB", "precondition");
      stack.pop();
    } else stack.at(-1)!.push(token.startsWith('"') ? kicadString(token) : token);
  }
  const result = stack[0]![0];
  if (
    stack.length !== 1 ||
    stack[0]!.length !== 1 ||
    !Array.isArray(result) ||
    result[0] !== "kicad_pcb"
  )
    throw new ToolError("invalid saved PCB", "precondition");
  return result;
}
const children = (node: Node[], key: string) =>
  node.filter((item): item is Node[] => Array.isArray(item) && item[0] === key);
const child = (node: Node[], key: string) => children(node, key)[0] ?? [];
const string = (node: Node[], key: string) => String(child(node, key)[1] ?? "");
const identity = (node: Node[]) => string(node, "uuid") || string(node, "tstamp");
// Native numeric spellings (.2 / 0.2) do not describe different geometry.
const numericNode = (node: Node): unknown =>
  !Array.isArray(node)
    ? /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(node)
      ? Number(node)
      : node
    : node.map((value, index) => (index === 0 ? value : numericNode(value)));
type ObjectFact = {
  category: string;
  id: string;
  reference: string | null;
  net: string | null;
  value: string;
};
function pcbFacts(text: string): ObjectFact[] {
  const board = parsePcb(text);
  const names = new Map(
    children(board, "net").map((node) => [String(node[1]), String(node[2] ?? node[1])]),
  );
  const netOf = (node: Node[]) => {
    const net = child(node, "net");
    const value = String(net.at(-1) ?? "");
    return names.get(value) ?? value;
  };
  const withoutIds = (node: Node): Node =>
    !Array.isArray(node)
      ? node
      : node
          .filter(
            (value) => !Array.isArray(value) || !["uuid", "tstamp"].includes(String(value[0])),
          )
          .map(withoutIds);
  const facts: ObjectFact[] = [];
  for (const category of ["segment", "arc", "via"]) {
    for (const node of children(board, category)) {
      const normalized: Node[] = [
        category,
        ...[
          "start",
          "mid",
          "end",
          "at",
          "width",
          "size",
          "drill",
          "layer",
          "layers",
          "locked",
          "type",
        ].map((key) => child(node, key)),
        ["net", netOf(node)],
      ];
      facts.push({
        category,
        id: identity(node) || `anonymous-${digest(JSON.stringify(normalized))}`,
        reference: null,
        net: netOf(node),
        value: JSON.stringify(
          normalized.map((value) =>
            Array.isArray(value) && value[0] === "net" ? value : numericNode(value),
          ),
        ),
      });
    }
  }
  for (const node of children(board, "footprint")) {
    const reference = String(
      children(node, "property").find((property) => property[1] === "Reference")?.[2] ??
        children(node, "fp_text").find((value) => value[1] === "reference")?.[2] ??
        "",
    );
    const id = identity(node) || reference;
    facts.push({
      category: "footprint",
      id,
      reference,
      net: null,
      value: JSON.stringify({
        library: node[1],
        at: numericNode(child(node, "at")),
        transform: numericNode(child(node, "transform")),
        layer: child(node, "layer"),
        attrs: child(node, "attr"),
        properties: children(node, "property").map(withoutIds),
      }),
    });
    for (const pad of children(node, "pad")) {
      // Duplicate pad numbers (e.g. multiple GND pads) remain distinct when UUIDs are present.
      facts.push({
        category: "pad",
        id: `${id}:${identity(pad) || String(pad[1])}`,
        reference,
        net: netOf(pad),
        value: JSON.stringify({
          number: pad[1],
          net: netOf(pad),
          at: numericNode(child(pad, "at")),
          transform: numericNode(child(pad, "transform")),
          layers: child(pad, "layers"),
          size: numericNode(child(pad, "size")),
          drill: numericNode(child(pad, "drill")),
        }),
      });
    }
  }
  return facts;
}
export type TaskChange = {
  category: string;
  id: string;
  kind: "added" | "removed" | "modified" | "identity-only";
  references: string[];
  nets: string[];
  scope: "inside" | "outside" | "undeclared";
};
export function compareTaskPcb(
  before: string,
  after: string,
  scope: z.infer<typeof TaskScope> | null,
) {
  const toMap = (text: string) => {
    const map = new Map<string, ObjectFact>();
    for (const fact of pcbFacts(text)) {
      const key = `${fact.category}:${fact.id}`;
      if (map.has(key))
        throw new ToolError(`ambiguous saved PCB object identity: ${key}`, "precondition");
      map.set(key, fact);
    }
    return map;
  };
  const a = toMap(before),
    b = toMap(after),
    changes: TaskChange[] = [];
  // Match equal measured content when a native save replaces IDs. This records identity
  // churn separately, without asserting electrical geometry changed or hiding ID changes.
  const equivalents = new Map<string, string[]>();
  for (const [key, fact] of b)
    if (!a.has(key)) {
      const signature = `${fact.category}:${fact.value}`;
      equivalents.set(signature, [...(equivalents.get(signature) ?? []), key]);
    }
  const paired = new Map<string, string>(),
    consumed = new Set<string>();
  for (const [key, fact] of a)
    if (!b.has(key)) {
      const other = equivalents.get(`${fact.category}:${fact.value}`)?.shift();
      if (other) {
        paired.set(key, other);
        consumed.add(other);
      }
    }
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (consumed.has(key)) continue;
    const old = a.get(key),
      current = b.get(paired.get(key) ?? key);
    if (old?.value === current?.value && !paired.has(key)) continue;
    const fact = current ?? old!;
    const nets = [
      ...new Set([old?.net, current?.net].filter((v): v is string => Boolean(v))),
    ].sort();
    const references = [
      ...new Set([old?.reference, current?.reference].filter((v): v is string => Boolean(v))),
    ].sort();
    // Reference permission authorizes footprint/pad changes, not every connected net's copper.
    const inside =
      fact.category === "footprint" || fact.category === "pad"
        ? references.length > 0 && references.every((ref) => scope?.references.includes(ref))
        : nets.length > 0 && nets.every((net) => scope?.nets.includes(net));
    changes.push({
      category: fact.category,
      id: fact.id,
      kind: paired.has(key) ? "identity-only" : !old ? "added" : !current ? "removed" : "modified",
      nets,
      references,
      scope: scope === null ? "undeclared" : inside ? "inside" : "outside",
    });
  }
  return changes;
}

export async function compareTaskCheckpoint(project: ProjectHandle, checkpointId?: string) {
  const records = await listTaskCheckpoints(project);
  const checkpoint = checkpointId
    ? records.find((value) => value.id === checkpointId)
    : records.find((value) => value.role === "baseline");
  if (!checkpoint) {
    if (checkpointId) throw new ToolError("task checkpoint not found", "not_found");
    return null;
  }
  const saved = await checkpointFiles(project, checkpoint);
  const current = await stableCapture(project);
  const paths = new Set([
    ...saved.map((value) => value.path),
    ...current.map((value) => value.path),
  ]);
  const files = [...paths]
    .map((path) => ({
      path,
      before: saved.find((value) => value.path === path)?.sha256 ?? null,
      after: current.find((value) => value.path === path)?.sha256 ?? null,
    }))
    .filter((file) => file.before !== file.after);
  const before = saved.find((value) => value.path === "board.kicad_pcb")?.data;
  const after = current.find((value) => value.path === "board.kicad_pcb")?.data;
  const changes =
    before && after
      ? compareTaskPcb(before.toString("utf8"), after.toString("utf8"), checkpoint.scope)
      : [];
  return {
    checkpointId: checkpoint.id,
    name: checkpoint.name,
    baselineRevision: checkpoint.revision,
    currentRevision: revision(identities(current)),
    scope: checkpoint.scope,
    files,
    changeCount: changes.filter((value) => value.kind !== "identity-only").length,
    identityChangeCount: changes.filter((value) => value.kind === "identity-only").length,
    outsideScopeCount: changes.filter(
      (value) => value.kind !== "identity-only" && value.scope === "outside",
    ).length,
    changes,
    truncated: false,
    changedNets: [
      ...new Set(
        changes.filter((value) => value.kind !== "identity-only").flatMap((value) => value.nets),
      ),
    ].sort(),
    changedReferences: [
      ...new Set(
        changes
          .filter((value) => value.kind !== "identity-only")
          .flatMap((value) => value.references),
      ),
    ].sort(),
    coverage: {
      pcbObjects:
        before && after
          ? "tracks/arcs/vias, placement/properties/attributes, pad net/geometry"
          : "unavailable: board missing in baseline or current state",
      schematicConnectivity: "unmeasured; saved native byte changes only",
      zonesAndFill: "unmeasured; saved native byte changes only",
      nativeChecks: "not run; no task acceptance inferred",
      restoration: "not provided by this operation",
      observation: "saved files checked repeatedly; unsaved GUI state is not observed",
      nativeFileCoverage:
        "project native files/rules/tables including hidden child files; known runtime/output directories excluded; local symbol/footprint libraries, models and external resources not captured; complete reproducible project/hierarchy not established",
    },
  };
}
export function taskCheckpointText(comparison: Awaited<ReturnType<typeof compareTaskCheckpoint>>) {
  if (!comparison)
    return "Task baseline: none retained; project_checkpoint can retain explicit scope and native files.";
  return `Task baseline ${comparison.checkpointId}: ${comparison.files.length} native file(s) changed, ${comparison.changeCount} measured PCB object changes (${comparison.identityChangeCount} equivalent-content identity replacements), ${comparison.outsideScopeCount} outside declared scope${comparison.scope === null ? "; scope undeclared" : ""}. Native checks not run; schematic/zone-fill changes are not semantically measured.`;
}

export function compactTaskComparison(
  comparison: Awaited<ReturnType<typeof compareTaskCheckpoint>>,
) {
  return comparison
    ? {
        ...comparison,
        changes: [...comparison.changes]
          .sort(
            (a, b) =>
              Number(a.kind === "identity-only") - Number(b.kind === "identity-only") ||
              Number(b.scope === "outside") - Number(a.scope === "outside"),
          )
          .slice(0, 30),
        truncated: comparison.changes.length > 30,
        changedNets: comparison.changedNets.slice(0, 30),
        changedNetCount: comparison.changedNets.length,
        changedReferences: comparison.changedReferences.slice(0, 30),
        changedReferenceCount: comparison.changedReferences.length,
      }
    : null;
}
