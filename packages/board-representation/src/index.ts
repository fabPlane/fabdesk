/** Saved-source facts. No acceptance policy or writes to the native design. */
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  stat,
  rename,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { KiCad } from "@fp-pcb/client";
import { NngIpcTransport } from "@fp-pcb/client/transport";
import { parseLibraryTable, serializeLibraryTable, type KicadCli } from "@fabdesk/kicad";
import { z } from "zod/v4";

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const json = (v: unknown) =>
  JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
// Native document parents and nested decoration IDs are regenerated on load.
// Preserve them in evidence; compare only the stable part of the observation.
function stripNative(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => stripNative(v, false));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "parent" && (top || k !== "id"))
        .map(([k, v]) => [k, stripNative(v, false)]),
    );
  return value;
}
function comparable(value: Fact | undefined) {
  return value ? { ...value, native: stripNative(value.native) } : null;
}
const error = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Manifest = Record<string, string | null>;
type Box = { x: number; y: number; w: number; h: number };
export type Fact = {
  id: string;
  type: string;
  parent: string | null;
  net: string | null;
  reference: string | null;
  library: string | null;
  bounds: Box | null;
  native: unknown;
};
const finding = z
  .object({
    type: z.string(),
    severity: z.enum(["error", "warning", "exclusion"]),
    description: z.string(),
    items: z.array(
      z
        .object({
          uuid: z.string(),
          description: z.string(),
          pos: z.object({ x: z.number().finite(), y: z.number().finite() }),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const receipt = z
  .object({
    $schema: z.literal("https://schemas.kicad.org/drc.v1.json"),
    coordinate_units: z.literal("mm"),
    source: z.string(),
    kicad_version: z.string(),
    included_severities: z.array(z.string()),
    ignored_checks: z.array(z.unknown()),
    violations: z.array(finding),
    unconnected_items: z.array(finding),
    schematic_parity: z.array(finding),
  })
  .passthrough();
export type Finding = z.infer<typeof finding> & { handle: string; category: string };
export type Check = {
  status: "measured" | "failed";
  basis: "saved-fill";
  failure?: string;
  sha256?: string;
  coverage?: { ignored: unknown[]; included: string[] };
  findings?: Finding[];
  invocation?: string[];
  stdout?: string;
  stderr?: string;
};
export type Evidence = {
  schema: "fabdesk.board-representation.v1";
  revision: string;
  evidenceSha256?: string;
  sourceRevision?: string;
  board: string;
  capturedAt: string;
  sourceStatus: "current" | "unsettled" | "failed";
  actionStatus: "not-applicable";
  manifest: Manifest;
  unresolved: string[];
  runtime: unknown;
  context?: unknown;
  facts: Fact[];
  check: Check;
  failure?: string;
  previous: string | null;
  lastGood?: string | null;
  changes?: {
    added: string[];
    removed: string[];
    changed: string[];
    checksComparable: boolean;
    findings?: { new: string[]; resolved: string[] };
    sourceContentChanged: boolean;
    interpretation: string;
  };
};
export type Resolver = (options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
}) => Promise<KicadCli | null>;

async function fileHash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function runtimeIdentity(cli: KicadCli) {
  const files: Manifest = {};
  for (const path of [
    cli.path,
    join(dirname(cli.path), "bin", basename(cli.path)),
    join(dirname(cli.path), "KICAD_COMMIT"),
  ])
    if (await stat(path).catch(() => null)) files[path] = await fileHash(path);
  return {
    path: cli.path,
    version: cli.version,
    files,
    identity: hash(json(files)),
    scope: scopes.runtime,
  };
}
function validateTable(text: string) {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (--depth < 0) throw Error("Malformed library table");
    }
  }
  if (depth !== 0 || quoted) throw Error("Partial library table");
}
async function optional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function safe(root: string, path: string): Promise<string> {
  const p = resolve(root, path),
    r = relative(root, p);
  if (r.startsWith("..") || isAbsolute(r)) throw Error("Source path escapes project");
  const canonical = await realpath(p).catch(async (e) => {
    if (e.code !== "ENOENT") throw e;
    return join(await realpath(dirname(p)), basename(p));
  });
  const rel = relative(await realpath(root), canonical);
  if (rel.startsWith("..") || isAbsolute(rel)) throw Error("Source symlink escapes project");
  return p;
}
/** Local dependency bytes are frozen; unresolved rows prevent checking against live assets. */
export async function captureInputs(project: string, board: string) {
  const selected = await safe(project, board);
  const dir = dirname(selected);
  const bytes: Record<string, Buffer> = {};
  const manifest: Manifest = {};
  const unresolved: string[] = [];
  const checkerTables: Record<string, Buffer> = {};
  let size = 0;
  let visited = 0;
  const directories = new Set<string>();
  const add = async (path: string): Promise<void> => {
    const absolute = await safe(project, path),
      name = relative(project, absolute).replaceAll("\\", "/");
    if (name in manifest) return;
    const info = await stat(absolute).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (++visited > 8192) throw Error("Dependency entry limit exceeded");
    if (info?.isDirectory()) {
      const canonical = await realpath(absolute);
      if (directories.has(canonical)) throw Error("Library ancestor cycle");
      directories.add(canonical);
      try {
        for (const n of (await readdir(absolute)).sort()) await add(join(absolute, n));
      } finally {
        directories.delete(canonical);
      }
      return;
    }
    const data = await optional(absolute);
    size += data?.length ?? 0;
    if (Object.keys(manifest).length > 4096 || size > 250 * 1024 * 1024)
      throw Error("Source dependency limit exceeded");
    manifest[name] = data ? hash(data) : null;
    if (data) bytes[name] = data;
  };
  for (const p of [
    selected,
    selected.replace(/\.kicad_pcb$/, ".kicad_pro"),
    selected.replace(/\.kicad_pcb$/, ".kicad_dru"),
    join(dir, "fp-lib-table"),
    join(dir, "sym-lib-table"),
  ])
    await add(p);
  if (!bytes[relative(project, selected).replaceAll("\\", "/")])
    throw Error("Selected board is missing");
  for (const table of ["fp-lib-table", "sym-lib-table"]) {
    const text = await optional(join(dir, table));
    if (!text) {
      unresolved.push(`${table}: absent; global libraries not captured`);
      continue;
    }
    // The existing table parser skips malformed entries. Native loading remains authoritative;
    // a table not recognized at all is never represented as an empty valid table.
    if (!text.toString().includes(table === "fp-lib-table" ? "(fp_lib_table" : "(sym_lib_table"))
      throw Error("Unrecognized library table");
    validateTable(text.toString());
    const rows = parseLibraryTable(text.toString());
    let unsupported = false;
    if ((text.toString().match(/\(lib\s/g) ?? []).length !== rows.length) {
      unresolved.push(`${table}: unrecognized rows`);
      unsupported = true;
    }
    for (const row of rows) {
      if (row.disabled) continue;
      const local = row.uri.replaceAll("${KIPRJMOD}", dir);
      if (row.type !== "KiCad" || /\$[({]/.test(local)) {
        unresolved.push(`library:${row.name}:${row.uri}`);
        unsupported = true;
        continue;
      }
      try {
        await add(isAbsolute(local) ? local : resolve(dir, local));
        const absolute = isAbsolute(local) ? local : resolve(dir, local);
        if (!(await stat(absolute).catch(() => null))) {
          unresolved.push(`missing-library:${row.name}`);
          unsupported = true;
        } else row.uri = "${KIPRJMOD}/" + relative(dir, absolute).replaceAll("\\", "/");
      } catch (e) {
        unresolved.push(`library:${row.name}:${error(e)}`);
        unsupported = true;
      }
    }
    checkerTables[relative(project, join(dir, table)).replaceAll("\\", "/")] = Buffer.from(
      serializeLibraryTable(
        table === "fp-lib-table" ? "footprint" : "symbol",
        unsupported ? [] : rows,
      ),
    );
  }
  return {
    bytes,
    checkerTables,
    manifest: Object.fromEntries(Object.entries(manifest).sort()),
    unresolved,
  };
}
async function install(root: string, bytes: Record<string, Buffer>) {
  for (const [name, data] of Object.entries(bytes)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
}
async function copyProfile(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const n of await readdir(from)) {
    const a = join(from, n),
      b = join(to, n);
    if ((await stat(a)).isDirectory()) await copyProfile(a, b);
    else await writeFile(b, await readFile(a));
  }
}
async function profile(root: string) {
  const config = join(root, "config"),
    xdg = join(root, "xdg");
  await mkdir(config, { recursive: true });
  await mkdir(xdg, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("KICAD") && !["XDG_CONFIG_HOME", "PYTHONPATH"].includes(k)) env[k] = v;
  env.KICAD_CONFIG_HOME = config;
  env.XDG_CONFIG_HOME = xdg;
  return env;
}
async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const p = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const abort = () => p.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => p.kill("SIGKILL"), 120000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    signal.throwIfAborted();
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
async function native(
  cli: KicadCli,
  root: string,
  board: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<Fact[]> {
  if (process.platform === "win32")
    throw Error("Native representation transport not qualified on Windows yet");
  const socket = join(root, "api.sock"),
    cmd = [cli.path, "api-server", join(root, "source", board), "--socket", socket];
  const p = Bun.spawn(cmd, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  // Drain immediately: a full diagnostic pipe must not deadlock startup or cleanup.
  const logs = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  let api: KiCad | undefined;
  const abort = () => {
    p.kill("SIGKILL");
    void api?.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const deadline = Date.now() + 15000;
    while (!(await stat(socket).catch(() => null))) {
      signal.throwIfAborted();
      if (p.exitCode !== null || Date.now() > deadline) throw Error("Native API did not start");
      await Bun.sleep(50);
    }
    api = await KiCad.connect(new NngIpcTransport({ path: socket }), {
      clientName: "fabdesk-board-representation",
      readyTimeoutMs: 15000,
    });
    const b = await api.currentBoard();
    if (!b) throw Error("Native board load failed");
    const before = await b.revision(),
      items = await b.getAllItems(),
      bounds = await b.boundingBoxes(items.map((i) => i.id));
    if (before !== (await b.revision())) throw Error("Native revision changed during capture");
    const ids = new Set<string>();
    const allIds = new Set(items.map((i) => i.id));
    return items
      .map((i) => {
        if (!i.id || ids.has(i.id)) throw Error("Missing or duplicate native identity");
        ids.add(i.id);
        return {
          id: i.id,
          type: i.typeName,
          parent: i.parent && allIds.has(i.parent) ? i.parent : null,
          net: i.net ?? null,
          reference: "reference" in i ? String(i.reference) : null,
          library: "libraryId" in i ? String(i.libraryId) : null,
          bounds: bounds.get(i.id) ?? null,
          native: i.toJson(),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (cause) {
    p.kill("SIGKILL");
    await p.exited;
    const [stdout, stderr] = await logs;
    throw Error(`${error(cause)}; native stdout: ${stdout}; native stderr: ${stderr}`);
  } finally {
    signal.removeEventListener("abort", abort);
    await api?.close();
    p.kill("SIGKILL");
    await p.exited;
    await logs;
  }
}
async function measure(
  cli: KicadCli,
  root: string,
  board: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<Check> {
  const invocation = [
    cli.path,
    "pcb",
    "drc",
    "--format",
    "json",
    "--units",
    "mm",
    "--severity-all",
    "--output",
    join(root, "receipt.json"),
    join(root, "source", board),
  ];
  try {
    const result = await run(invocation, root, env, signal);
    if (result.code !== 0)
      return {
        status: "failed",
        basis: "saved-fill",
        failure: `Native DRC exit ${result.code}`,
        invocation,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    const raw = await readFile(join(root, "receipt.json"));
    const d = receipt.parse(JSON.parse(raw.toString()));
    if (d.source !== basename(board) || d.kicad_version !== cli.version)
      throw Error("Receipt source/runtime mismatch");
    const findings: Finding[] = [];
    const occurrences = new Map<string, number>();
    for (const category of ["violations", "unconnected_items", "schematic_parity"] as const)
      for (const f of d[category]) {
        const key = hash(json([category, f]));
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        findings.push({ ...f, category, handle: `${key}:${occurrence}` });
      }
    return {
      status: "measured",
      basis: "saved-fill",
      sha256: hash(raw),
      coverage: { ignored: d.ignored_checks, included: d.included_severities },
      findings,
      invocation,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (e) {
    return { status: "failed", basis: "saved-fill", failure: error(e), invocation };
  }
}
const scopes = {
  geometry:
    "Native protobuf fields and native nm bounds; original saved bytes retained. Not every field is interpreted.",
  connectivity:
    "Terminal partitions not measured; DRC unconnected findings are separate saved-fill observations.",
  rules: "Effective rule resolution not independently verified.",
  schematic: "Not captured; no parity or intent proof.",
  runtime:
    "CLI identity recorded; external dynamic libraries, fonts and stock libraries not hermetically captured.",
};
function validateEvidence(e: Evidence) {
  const { evidenceSha256, ...body } = e;
  if (evidenceSha256 !== hash(json(body))) throw Error("Representation evidence hash mismatch");
}
export function packet(e: Evidence) {
  return {
    schema: e.schema,
    evidenceSha256: e.evidenceSha256,
    sourceRevision: e.sourceRevision,
    revision: e.revision,
    board: e.board,
    capturedAt: e.capturedAt,
    sourceStatus: e.sourceStatus,
    actionStatus: e.actionStatus,
    previous: e.previous,
    lastGood: e.lastGood,
    failure: e.failure,
    manifest: e.manifest,
    unresolved: e.unresolved,
    runtime: e.runtime,
    context: e.context,
    components: e.facts
      .filter((f) => f.reference !== null)
      .map((f) => ({ id: f.id, reference: f.reference, library: f.library })),
    nets: [...new Set(e.facts.flatMap((f) => (f.net ? [f.net] : [])))].sort(),
    coverage: scopes,
    counts:
      e.sourceStatus === "failed"
        ? null
        : Object.fromEntries(
            [...new Set(e.facts.map((f) => f.type))].map((type) => [
              type,
              e.facts.filter((f) => f.type === type).length,
            ]),
          ),
    check: {
      status: e.check.status,
      basis: e.check.basis,
      failure: e.check.failure,
      coverage: e.check.coverage,
      sha256: e.check.sha256,
      counts:
        e.check.status === "measured"
          ? Object.fromEntries(
              ["error", "warning", "exclusion"].map((s) => [
                s,
                e.check.findings!.filter((f) => f.severity === s).length,
              ]),
            )
          : null,
    },
    changes: e.changes,
    evidence: {
      revision: e.revision,
      detail: "inspect with revision and component/net/region, or detail=receipt/source",
    },
  };
}
export async function refresh(
  project: string,
  board: string,
  resolver: Resolver,
  callSignal?: AbortSignal,
): Promise<Evidence> {
  const signal = callSignal
    ? AbortSignal.any([callSignal, AbortSignal.timeout(180000)])
    : AbortSignal.timeout(180000);
  signal.throwIfAborted();
  board = relative(project, await safe(project, board)).replaceAll("\\", "/");
  if (!board.endsWith(".kicad_pcb")) throw Error("Expected a native .kicad_pcb path");
  const store = join(project, ".fabdesk", "representation", hash(board)),
    lock = join(store, "lock");
  await mkdir(store, { recursive: true });
  try {
    await mkdir(lock);
  } catch {
    throw Error("Representation refresh busy (exclusive lock exists)");
  }
  let scratch = "";
  const revision = randomUUID(),
    generation = join(store, revision),
    pending = join(store, `.pending-${revision}`);
  let previous: Evidence | null = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), "fabdesk-representation-"));
    const prior = await optional(join(store, "current.json"));
    if (prior) {
      previous = JSON.parse(prior.toString()) as Evidence;
      validateEvidence(previous);
    }
    const e: Evidence = {
      schema: "fabdesk.board-representation.v1",
      revision,
      board,
      capturedAt: new Date().toISOString(),
      sourceStatus: "failed",
      actionStatus: "not-applicable",
      manifest: {},
      unresolved: [],
      runtime: null,
      facts: [],
      check: { status: "failed", basis: "saved-fill", failure: "Capture did not complete" },
      previous: previous?.revision ?? null,
    };
    await mkdir(pending);
    try {
      const input = await captureInputs(project, board);
      e.manifest = input.manifest;
      e.sourceRevision = hash(json(input.manifest));
      e.unresolved = [...input.unresolved];
      await install(join(pending, "source"), input.bytes);
      await install(join(pending, "measurement-tables"), input.checkerTables);
      await install(join(scratch, "source"), { ...input.bytes, ...input.checkerTables });
      const env = await profile(scratch),
        cli = await resolver({
          env,
          cwd: scratch,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
      if (!cli) throw Error("No configured native KiCad runtime available");
      e.runtime = await runtimeIdentity(cli);
      e.context = {
        checkerInputs: hash(
          json({
            manifest: Object.fromEntries(
              Object.entries(input.manifest).filter(([name]) => name !== board),
            ),
            unresolved: input.unresolved,
          }),
        ),
        profile: "empty isolated writable profile per refresh",
        locale: { LANG: env.LANG ?? null, LC_ALL: env.LC_ALL ?? null },
        discovery: [cli.path, "version"],
        basis: "saved-fill",
        checkerTables: Object.fromEntries(
          Object.entries(input.checkerTables).map(([n, v]) => [n, hash(v)]),
        ),
      };
      // Library tables are normalized to frozen local paths; unsupported tables are empty
      // only in the disposable measurement, with their missing scope explicit above.
      e.facts = await native(cli, scratch, board, env, signal);
      const available = new Set(
        Object.values(input.checkerTables).flatMap((v) =>
          parseLibraryTable(v.toString()).map((r) => r.name),
        ),
      );
      for (const lib of new Set(
        e.facts.flatMap((f) => (f.library ? [f.library.split(":")[0] || "(unqualified)"] : [])),
      ))
        if (!available.has(lib))
          e.unresolved.push(`footprint-library:${lib}:not captured in local measurement tables`);
      e.check = await measure(cli, scratch, board, env, signal);
      if (await optional(join(scratch, "receipt.json")))
        await writeFile(
          join(pending, "receipt.json"),
          await readFile(join(scratch, "receipt.json")),
        );
      if (json(await runtimeIdentity(cli)) !== json(e.runtime))
        throw Error("Native executable changed during measurement");
      for (const [name, data] of Object.entries(input.bytes)) {
        if (
          hash(await readFile(join(scratch, "source", name))) !==
          hash(input.checkerTables[name] ?? data)
        )
          throw Error("Native runtime mutated captured source");
      }
      await copyProfile(join(scratch, "config"), join(pending, "profile-after"));
      const after = await captureInputs(project, board);
      e.sourceStatus =
        json(after.manifest) === json(input.manifest) &&
        json(after.unresolved) === json(input.unresolved)
          ? "current"
          : "unsettled";
      if (previous?.sourceStatus === "current") {
        const b = new Map(previous.facts.map((f) => [f.id, f])),
          a = new Map(e.facts.map((f) => [f.id, f]));
        e.changes = {
          sourceContentChanged: json(e.manifest) !== json(previous.manifest),
          interpretation:
            "Native observation differences; regenerated parent and nested decoration IDs omitted from comparison. Raw fields retained; remove/add UUID correspondence uncertain.",
          added: [...a.keys()].filter((k) => !b.has(k)),
          removed: [...b.keys()].filter((k) => !a.has(k)),
          changed: [...a.keys()].filter(
            (k) => b.has(k) && json(comparable(a.get(k))) !== json(comparable(b.get(k))),
          ),
          checksComparable:
            e.check.status === "measured" &&
            previous.check.status === "measured" &&
            json(e.check.coverage) === json(previous.check.coverage) &&
            json(e.runtime) === json(previous.runtime) &&
            json(e.context) === json(previous.context) &&
            json(e.unresolved) === json(previous.unresolved),
        };
        if (e.changes.checksComparable) {
          const old = new Set(previous.check.findings!.map((f) => f.handle)),
            now = new Set(e.check.findings!.map((f) => f.handle));
          e.changes.findings = {
            new: [...now].filter((h) => !old.has(h)),
            resolved: [...old].filter((h) => !now.has(h)),
          };
        }
      }
    } catch (cause) {
      e.failure = error(cause);
      e.sourceStatus = "failed";
    }
    signal.throwIfAborted();
    // Final publication read includes dependency content and absence, not only board mtime.
    if (e.sourceStatus === "current") {
      try {
        if (json((await captureInputs(project, board)).manifest) !== json(e.manifest))
          e.sourceStatus = "unsettled";
      } catch {
        e.sourceStatus = "unsettled";
      }
    }
    e.lastGood =
      e.sourceStatus === "current"
        ? revision
        : (previous?.lastGood ?? (previous?.sourceStatus === "current" ? previous.revision : null));
    e.evidenceSha256 = hash(json(e));
    await writeFile(join(pending, "evidence.json"), json(e));
    await rename(pending, generation);
    const pointer = join(store, `.pointer-${revision}`);
    await writeFile(pointer, json(e));
    await rename(pointer, join(store, "current.json"));
    return e;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
export async function inspect(
  project: string,
  board: string,
  revision: string,
  options: {
    component?: string;
    net?: string;
    region?: number[];
    detail?: "facts" | "receipt" | "source";
    finding?: string;
  } = {},
) {
  if (!/^[a-f0-9-]{36}$/.test(revision)) throw Error("Invalid evidence revision");
  const root = join(project, ".fabdesk", "representation", hash(board), revision),
    e = JSON.parse(await readFile(join(root, "evidence.json"), "utf8")) as Evidence;
  validateEvidence(e);
  if (e.revision !== revision || e.board !== board) throw Error("Evidence binding mismatch");
  if (options.detail === "receipt") {
    const raw = await optional(join(root, "receipt.json"));
    if (
      (e.check.status === "measured" && (!raw || !e.check.sha256)) ||
      (raw && e.check.sha256 && hash(raw) !== e.check.sha256)
    )
      throw Error("Receipt evidence hash mismatch");
    return { historical: true, revision, check: e.check, rawReceipt: raw?.toString() ?? null };
  }
  if (options.detail === "source")
    return {
      historical: true,
      revision,
      manifest: e.manifest,
      files: Object.fromEntries(
        await Promise.all(
          Object.entries(e.manifest)
            .filter(([, v]) => v !== null)
            .map(async ([name, expected]) => {
              const data = await readFile(join(root, "source", name));
              if (hash(data) !== expected) throw Error("Source evidence hash mismatch: " + name);
              return [name, data.toString("base64")];
            }),
        ),
      ),
      encoding: "base64",
    };
  const findingIds = options.finding
    ? new Set(
        e.check.findings
          ?.filter((f) => f.handle === options.finding)
          .flatMap((f) => f.items.map((i) => i.uuid)),
      )
    : null;
  const roots = new Set(
    e.facts
      .filter((f) => f.id === options.component || f.reference === options.component)
      .map((f) => f.id),
  );
  const facts = e.facts.filter(
    (f) =>
      (!findingIds || findingIds.has(f.id)) &&
      (!options.component || roots.has(f.id) || (!!f.parent && roots.has(f.parent))) &&
      (options.net === undefined || f.net === options.net) &&
      (!options.region ||
        (!!f.bounds &&
          f.bounds.x <= options.region[2]! * 1e6 &&
          f.bounds.x + f.bounds.w >= options.region[0]! * 1e6 &&
          f.bounds.y <= options.region[3]! * 1e6 &&
          f.bounds.y + f.bounds.h >= options.region[1]! * 1e6)),
  );
  const ids = new Set(facts.map((f) => f.id));
  return {
    historical: true,
    revision,
    coverage: scopes,
    facts,
    checkStatus: e.check.status,
    findings: e.check.findings?.filter(
      (f) =>
        (!options.finding || f.handle === options.finding) &&
        ((!options.component && options.net === undefined && !options.region) ||
          f.items.some((i) => ids.has(i.uuid))),
    ),
  };
}
