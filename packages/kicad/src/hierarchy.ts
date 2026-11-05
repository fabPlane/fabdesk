import { exportSchematicSvg } from "./exports";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { runKicadCli, type KicadCli } from "./cli";

export type SchematicHierarchyIssue = {
  kind: "missing" | "unreadable" | "duplicate" | "cycle" | "parse" | "export";
  path: string;
  detail: string;
};

export type SchematicHierarchySheet = {
  hierarchyPath: string;
  nativePath: string;
  identity: string;
  name: string;
  depth: number;
  sha256: string;
  bytes: number;
  components: number;
  nets: number;
};

export type SchematicHierarchy = {
  rootFile: string;
  projectFile: string | null;
  aggregateRevision: string;
  complete: boolean;
  counts: { components: number; nets: number; sheets: number };
  sheets: SchematicHierarchySheet[];
  referencedFiles: string[];
  orphanFiles: string[];
  issues: SchematicHierarchyIssue[];
  source: {
    hierarchy: "native-kicad-project";
    electrical: "packaged-kicad-cli-netlist";
    kicadCli: { path: string; version: string };
  };
};

type TopLevelSheet = { filename?: unknown; name?: unknown; uuid?: unknown };
type PendingSheet = {
  absolute: string;
  hierarchyPath: string;
  identity: string;
  name: string;
  depth: number;
  ancestry: string[];
};

const slash = (path: string) => path.split(sep).join("/");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const uuid = (value: unknown): string =>
  /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.exec(String(value))?.[0] ?? "unknown";
const hierarchyPath = (parent: string, name: string) =>
  `${parent === "/" ? "/" : parent}${name.replaceAll("/", "_")}/`;
const xmlDecode = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

type NativeSheetReference = { filename: string; name: string; identity: string };

const unquote = (value: string) => value.replace(/\\([\\"])/g, "$1");

/** Tolerant native S-expression traversal: only top-level `sheet` blocks are interpreted. */
function parseNativeSchematic(text: string): { identity: string; sheets: NativeSheetReference[] } {
  if (!/^\s*\(kicad_sch\b/.test(text)) throw new Error("not a native kicad_sch document");
  const blocks: Array<{ text: string; identity: string }> = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let sheetStart = -1;
  let rootIdentity = "unknown";
  let sheetIdentity = "unknown";
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "(") {
      if (depth === 1 && /^\(sheet\s/.test(text.slice(index, index + 16))) {
        sheetStart = index;
        sheetIdentity = "unknown";
      }
      // KiCad 7 writes bare UUID atoms; newer files quote them. Only read the
      // document/sheet's own UUID, never a nested symbol, pin, or quoted property.
      if (depth === 1 || (depth === 2 && sheetStart >= 0)) {
        const match = /^\(uuid\s+(?:"([^"\\]+)"|([^\s()"]+))\s*\)/.exec(text.slice(index));
        const identity = match?.[1] ?? match?.[2];
        if (identity) {
          if (depth === 1) rootIdentity = identity;
          else sheetIdentity = identity;
        }
      }
      depth++;
    } else if (character === ")") {
      depth--;
      if (depth < 0) throw new Error("unbalanced closing parenthesis");
      if (sheetStart >= 0 && depth === 1) {
        blocks.push({ text: text.slice(sheetStart, index + 1), identity: sheetIdentity });
        sheetStart = -1;
      }
    }
  }
  if (quoted || depth !== 0) throw new Error("unterminated string or unbalanced parentheses");
  const sheets = blocks.map(({ text: block, identity }) => {
    const property = (key: string) => {
      const match = new RegExp(`\\(property\\s+"${key}"\\s+"((?:\\\\.|[^"])*)"`).exec(block);
      return match?.[1] ? unquote(match[1]) : undefined;
    };
    const filename = property("Sheetfile");
    if (!filename) throw new Error(`sheet ${uuid(identity)} has no Sheetfile property`);
    return {
      filename,
      name: property("Sheetname") ?? basename(filename, extname(filename)),
      identity,
    };
  });
  return { identity: rootIdentity, sheets };
}

async function schematicFiles(projectDir: string): Promise<string[]> {
  const entries = await readdir(projectDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".kicad_sch"))
    .map((entry) => slash(relative(projectDir, join(entry.parentPath, entry.name))))
    .filter((path) => !path.startsWith(".fabdesk/") && !path.startsWith("reports/"))
    .sort();
}

async function parseProject(projectFile: string): Promise<TopLevelSheet[]> {
  const parsed = JSON.parse(await readFile(projectFile, "utf8")) as {
    schematic?: { top_level_sheets?: unknown };
  };
  const top = parsed.schematic?.top_level_sheets;
  return Array.isArray(top) ? (top as TopLevelSheet[]) : [];
}

function electricalCounts(xml: string) {
  const componentBlocks = xml.match(/<comp\b[\s\S]*?<\/comp>/g) ?? [];
  const componentSheet = new Map<string, string>();
  const componentsBySheet = new Map<string, number>();
  for (const block of componentBlocks) {
    const reference = /<comp ref="([^"]+)"/.exec(block)?.[1];
    const sheet = xmlDecode(/<sheetpath names="([^"]*)"/.exec(block)?.[1] ?? "/");
    if (reference) componentSheet.set(xmlDecode(reference), sheet);
    componentsBySheet.set(sheet, (componentsBySheet.get(sheet) ?? 0) + 1);
  }
  const netBlocks = xml.match(/<net\b[\s\S]*?<\/net>/g) ?? [];
  const netsBySheet = new Map<string, Set<number>>();
  for (let index = 0; index < netBlocks.length; index++) {
    const sheets = new Set<string>();
    for (const match of netBlocks[index]!.matchAll(/<node ref="([^"]+)"/g)) {
      const sheet = componentSheet.get(xmlDecode(match[1]!));
      if (sheet) sheets.add(sheet);
    }
    for (const sheet of sheets) {
      const nets = netsBySheet.get(sheet) ?? new Set<number>();
      nets.add(index);
      netsBySheet.set(sheet, nets);
    }
  }
  return {
    components: componentBlocks.length,
    nets: netBlocks.length,
    sheets: (xml.match(/<sheet number=/g) ?? []).length,
    componentsBySheet,
    netsBySheet,
  };
}

/** Independently owned member bytes, including every parent directory. Legacy root projects retain their existing policy. */
async function readOwnedFile(projectDir: string, path: string): Promise<Buffer> {
  const rel = relative(projectDir, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || await realpath(projectDir) !== projectDir || await realpath(path) !== path) throw new Error("Native hierarchy file is outside the source or aliased");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) throw new Error("Native hierarchy file is not independently owned or exceeds 16 MiB");
    const bytes = await file.readFile(), after = await file.stat(), named = await lstat(path);
    const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
    if (!same(before, after) || !same(after, named) || await realpath(path) !== path) throw new Error("Native hierarchy file changed during inspection");
    return bytes;
  } finally { await file.close(); }
}

/** Export only the captured member hierarchy, never a second read of mutable live sheets. */
async function withOwnedFilesSnapshot<T>(rootFile: string, projectFile: string | null, top: TopLevelSheet[], files: Map<string, Buffer>, operation: (source: string, scratch: string) => Promise<T>) {
  const scratch = await mkdtemp(join(tmpdir(), "fabplane-owned-hierarchy-"));
  try {
    const put = async (path: string, bytes: Buffer) => {
      const dest = resolve(scratch, path), rel = relative(scratch, dest);
      if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Native project filename escapes its source snapshot");
      await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, bytes);
    };
    for (const [path, bytes] of files) await put(path, bytes);
    const first = typeof top[0]?.filename === "string" ? top[0].filename : null;
    // Imported KiCad projects may retain the original root filename in top_level_sheets.
    // Resolve relative to the project directory, not the process working directory.
    const chosen = projectFile && first && slash(first) !== rootFile ? slash(join(dirname(projectFile), first)) : rootFile;
    await put(chosen, files.get(rootFile)!);
    if (projectFile) await put(chosen.replace(/\.kicad_sch$/i, ".kicad_pro"), files.get(projectFile)!);
    return await operation(join(scratch, chosen), scratch);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function exportOwnedSnapshot(cli: KicadCli, rootFile: string, projectFile: string | null, top: TopLevelSheet[], files: Map<string, Buffer>, signal?: AbortSignal) {
  return withOwnedFilesSnapshot(rootFile, projectFile, top, files, async (source, scratch) => {
    const output = join(scratch, "hierarchy.xml");
    await runKicadCli(cli, ["sch", "export", "netlist", "--format", "kicadxml", "-o", output, source], { ...(signal ? { signal } : {}), cwd: dirname(source) });
    return readFile(output, "utf8");
  });
}

export type OwnedSchematicSvg = {
  sourceRevision: string;
  sourceFiles: Array<{ path: string; sha256: string }>;
  sheets: Array<{ name: string; svg: Uint8Array }>;
};

/** Export the exact inspected hierarchy; return bytes only after every captured file is rechecked. */
async function withCapturedSchematic<T>(opts: { projectDir: string; hierarchy: SchematicHierarchy; signal?: AbortSignal }, operation: (source: string, scratch: string) => Promise<T>) {
  const { hierarchy } = opts, dir = resolve(opts.projectDir);
  if (!hierarchy.complete || !hierarchy.sheets.length || hierarchy.sheets.length > 256) throw new Error("A complete bounded native hierarchy is required before schematic rendering");
  const files = new Map<string, Buffer>();
  for (const path of [...new Set([...hierarchy.referencedFiles, ...(hierarchy.projectFile ? [hierarchy.projectFile] : [])])]) files.set(path, await readOwnedFile(dir, resolve(dir, path)));
  if (!files.has(hierarchy.rootFile)) throw new Error("The inspected root schematic is not part of its hierarchy");
  const projectPath = resolve(dir, hierarchy.rootFile.replace(/\.kicad_sch$/i, ".kicad_pro"));
  const checkAbsentProject = async () => { if (!hierarchy.projectFile && await lstat(projectPath).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")) throw new Error("Native project metadata changed since hierarchy inspection"); };
  await checkAbsentProject();
  const revision = hash([...hierarchy.sheets.map(sheet => {
    const bytes = files.get(sheet.nativePath);
    if (!bytes || hash(bytes) !== sheet.sha256) throw new Error("A referenced schematic changed since hierarchy inspection");
    return `${sheet.hierarchyPath}\0${sheet.nativePath}\0${sheet.identity}\0${hash(bytes)}`;
  }), ...(hierarchy.projectFile ? [`project\0${hierarchy.projectFile}\0${hash(files.get(hierarchy.projectFile)!)}`] : [])].sort().join("\n"));
  if (revision !== hierarchy.aggregateRevision) throw new Error("The inspected hierarchy revision does not match the captured native files");
  let top: TopLevelSheet[] = [];
  if (hierarchy.projectFile) { const metadata = JSON.parse(files.get(hierarchy.projectFile)!.toString("utf8")); top = Array.isArray(metadata.schematic?.top_level_sheets) ? metadata.schematic.top_level_sheets : []; }
  const result = await withOwnedFilesSnapshot(hierarchy.rootFile, hierarchy.projectFile, top, files, operation);
  for (const [path, bytes] of files) if (hash(await readOwnedFile(dir, resolve(dir, path))) !== hash(bytes)) throw new Error("Native schematic files changed while exporting; the previous output was kept");
  await checkAbsentProject(); opts.signal?.throwIfAborted();
  return { sourceRevision: revision, sourceFiles: [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes) })), result };
}

/** Render immutable native sheets without altering any project source. */
export async function exportOwnedSchematicSvg(cli: KicadCli, opts: { projectDir: string; hierarchy: SchematicHierarchy; signal?: AbortSignal }): Promise<OwnedSchematicSvg> {
  const captured = await withCapturedSchematic(opts, async (source, scratch) => {
    const result = await exportSchematicSvg(cli, { schematic: source, outDir: join(scratch, "svg-output"), ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!result.paths.length || result.paths.length !== opts.hierarchy.sheets.length) throw new Error("Schematic export did not produce one preview per inspected sheet");
    const rootSvg = basename(source).replace(/\.kicad_sch$/i, ".svg");
    const paths = [...result.paths].sort((a, b) => Number(basename(b) === rootSvg) - Number(basename(a) === rootSvg) || a.localeCompare(b));
    return Promise.all(paths.map(async path => ({ name: basename(path), svg: new Uint8Array(await readFile(path)) })));
  });
  return { sourceRevision: captured.sourceRevision, sourceFiles: captured.sourceFiles, sheets: captured.result };
}

export type OwnedSchematicBom = { sourceRevision: string; sourceFiles: Array<{ path: string; sha256: string }>; csv: string };

/** Native default-variant BOM, with explicit fields and Do-Not-Populate exclusion. */
export async function exportOwnedSchematicBom(cli: KicadCli, opts: { projectDir: string; hierarchy: SchematicHierarchy; signal?: AbortSignal }): Promise<OwnedSchematicBom> {
  const captured = await withCapturedSchematic(opts, async (source, scratch) => {
    const output = join(scratch, "bom.csv");
    const fields = "Reference,Value,Footprint,MPN,Manufacturer,LCSC,QUANTITY,DNP,EXCLUDE_FROM_BOM,EXCLUDE_FROM_BOARD";
    await runKicadCli(cli, ["sch", "export", "bom", "--fields", fields, "--labels", fields, "--group-by", "", "--exclude-dnp", "--ref-range-delimiter", "", "-o", output, source], { ...(opts.signal ? { signal: opts.signal } : {}), cwd: dirname(source) });
    const info = await stat(output);
    if (info.size > 10 * 1024 * 1024) throw new Error("The native BOM exceeds the supported 10 MB limit");
    return readFile(output, "utf8");
  });
  return { sourceRevision: captured.sourceRevision, sourceFiles: captured.sourceFiles, csv: captured.result };
}

async function exportRoot(
  cli: KicadCli,
  projectDir: string,
  rootFile: string,
  projectFile: string | null,
  top: TopLevelSheet[],
  referenced: string[],
  signal?: AbortSignal,
): Promise<string> {
  let source = join(projectDir, rootFile);
  let scratch: string | null = null;
  const firstFilename = typeof top[0]?.filename === "string" ? slash(top[0].filename) : null;
  if (projectFile && firstFilename && firstFilename !== rootFile) {
    scratch = await mkdtemp(join(tmpdir(), "fabdesk-schematic-hierarchy-"));
    const copyRelative = async (path: string) => {
      const from = join(projectDir, path);
      const to = join(scratch!, path);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    };
    for (const path of referenced.filter((path) => path !== rootFile)) await copyRelative(path);
    for (const path of await readdir(projectDir))
      if (path === "sym-lib-table" || path.endsWith(".kicad_sym")) await copyRelative(path);
    source = join(scratch, firstFilename);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, await readFile(join(projectDir, rootFile)));
    const aliasedProject = source.replace(/\.kicad_sch$/i, ".kicad_pro");
    await writeFile(aliasedProject, await readFile(projectFile));
  }
  const outputDir = scratch ?? (await mkdtemp(join(tmpdir(), "fabdesk-schematic-netlist-")));
  const output = join(outputDir, "hierarchy.xml");
  try {
    await runKicadCli(
      cli,
      ["sch", "export", "netlist", "--format", "kicadxml", "-o", output, source],
      {
        ...(signal ? { signal } : {}),
        cwd: dirname(source),
      },
    );
    return await readFile(output, "utf8");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

/**
 * Builds the one saved native-project hierarchy used by every truth/status tool. Native KiCad
 * project/schematic references define membership; packaged KiCad's netlist export defines the
 * complete component/net facts. Live IPC counts are deliberately not used here.
 */
export async function inspectSchematicHierarchy(
  cli: KicadCli,
  opts: { projectDir: string; rootSchematic: string; projectFile?: string; signal?: AbortSignal; ownedFilesOnly?: boolean },
): Promise<SchematicHierarchy> {
  const projectDir = resolve(opts.projectDir);
  const rootAbsolute = resolve(opts.rootSchematic);
  const rootFile = slash(relative(projectDir, rootAbsolute));
  const projectAbsolute = opts.projectFile
    ? resolve(opts.projectFile)
    : rootAbsolute.replace(/\.kicad_sch$/i, ".kicad_pro");
  const projectMetadata = await stat(projectAbsolute).catch(() => null);
  const projectFile = projectMetadata?.isFile()
    ? slash(relative(projectDir, projectAbsolute))
    : null;
  const issues: SchematicHierarchyIssue[] = [];
  const ownedFiles = new Map<string, Buffer>();
  const readNative = async (path: string) => {
    if (!opts.ownedFilesOnly) return readFile(path);
    const key = slash(relative(projectDir, path)), captured = ownedFiles.get(key);
    if (captured) return captured; // Repeated sheet instances must export the same captured file bytes.
    const bytes = await readOwnedFile(projectDir, path); ownedFiles.set(key, bytes); return bytes;
  };
  let top: TopLevelSheet[] = [];
  if (projectFile) {
    try {
      if (opts.ownedFilesOnly) {
        const metadata = JSON.parse((await readNative(projectAbsolute)).toString("utf8")) as { schematic?: { top_level_sheets?: unknown } };
        top = Array.isArray(metadata.schematic?.top_level_sheets) ? metadata.schematic.top_level_sheets as TopLevelSheet[] : [];
      } else top = await parseProject(projectAbsolute);
    } catch (error) {
      issues.push({
        kind: "parse",
        path: projectFile,
        detail: `could not parse native project hierarchy metadata: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const pending: PendingSheet[] = [];
  if (top.length) {
    for (let index = 0; index < top.length; index++) {
      const item = top[index]!;
      if (typeof item.filename !== "string") {
        issues.push({
          kind: "parse",
          path: projectFile!,
          detail: `top-level sheet ${index + 1} has no filename`,
        });
        continue;
      }
      const file =
        index === 0 && slash(item.filename) !== rootFile
          ? rootAbsolute
          : resolve(dirname(projectAbsolute), item.filename);
      const name =
        typeof item.name === "string" && item.name
          ? item.name
          : basename(item.filename, extname(item.filename));
      pending.push({
        absolute: file,
        hierarchyPath: top.length === 1 ? "/" : `/${name}/`,
        identity: typeof item.uuid === "string" ? item.uuid : `top:${index}`,
        name,
        depth: 0,
        ancestry: [],
      });
    }
  } else {
    pending.push({
      absolute: rootAbsolute,
      hierarchyPath: "/",
      identity: "root",
      name: basename(rootFile, extname(rootFile)),
      depth: 0,
      ancestry: [],
    });
  }

  const partial: Array<Omit<SchematicHierarchySheet, "components" | "nets">> = [];
  const referencedFiles = new Set<string>();
  const identities = new Map<string, string>();
  while (pending.length) {
    const item = pending.shift()!;
    const nativePath = slash(relative(projectDir, item.absolute));
    if (nativePath === ".." || nativePath.startsWith("../")) {
      issues.push({
        kind: "parse",
        path: nativePath,
        detail: `schematic reference escapes project directory at ${item.hierarchyPath}`,
      });
      continue;
    }
    if (item.ancestry.includes(item.absolute)) {
      issues.push({
        kind: "cycle",
        path: nativePath,
        detail: `cyclic reference at ${item.hierarchyPath}`,
      });
      continue;
    }
    const previous = identities.get(item.identity);
    if (previous) {
      issues.push({
        kind: "duplicate",
        path: nativePath,
        detail: `sheet identity ${item.identity} is also used at ${previous}`,
      });
      continue;
    }
    identities.set(item.identity, item.hierarchyPath);
    let data: Buffer;
    try {
      data = await readNative(item.absolute);
    } catch (error) {
      issues.push({
        kind: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable",
        path: nativePath,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    let schematic: ReturnType<typeof parseNativeSchematic>;
    try {
      schematic = parseNativeSchematic(data.toString("utf8"));
    } catch (error) {
      issues.push({
        kind: "parse",
        path: nativePath,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    referencedFiles.add(nativePath);
    const identity = item.identity === "root" ? schematic.identity : item.identity;
    partial.push({
      hierarchyPath: item.hierarchyPath,
      nativePath,
      identity,
      name: item.name,
      depth: item.depth,
      sha256: hash(data),
      bytes: data.byteLength,
    });
    for (const sheet of schematic.sheets) {
      const { filename, name, identity: sheetIdentity } = sheet;
      const absolute = resolve(dirname(item.absolute), filename);
      pending.push({
        absolute,
        hierarchyPath: hierarchyPath(item.hierarchyPath, name),
        identity: `${item.identity}/${sheetIdentity}`,
        name,
        depth: item.depth + 1,
        ancestry: [...item.ancestry, item.absolute],
      });
    }
  }

  const allFiles = await schematicFiles(projectDir);
  const orphanFiles = allFiles.filter((path) => !referencedFiles.has(path));
  let counts = { components: 0, nets: 0, sheets: partial.length };
  let componentsBySheet = new Map<string, number>();
  let netsBySheet = new Map<string, Set<number>>();
  if (!issues.some((issue) => issue.kind !== "duplicate")) {
    try {
      const xml = opts.ownedFilesOnly ? await exportOwnedSnapshot(cli, rootFile, projectFile, top, ownedFiles, opts.signal) : await exportRoot(
        cli,
        projectDir,
        rootFile,
        projectFile ? join(projectDir, projectFile) : null,
        top,
        [...referencedFiles],
        opts.signal,
      );
      const measured = electricalCounts(xml);
      counts = { components: measured.components, nets: measured.nets, sheets: measured.sheets };
      componentsBySheet = measured.componentsBySheet;
      netsBySheet = measured.netsBySheet;
    } catch (error) {
      issues.push({
        kind: "export",
        path: rootFile,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (opts.ownedFilesOnly) {
    for (const [path, bytes] of ownedFiles) {
      try { if (hash(await readOwnedFile(projectDir, join(projectDir, path))) !== hash(bytes)) throw new Error("Saved bytes changed during inspection"); }
      catch (error) { issues.push({ kind: "unreadable", path, detail: error instanceof Error ? error.message : String(error) }); }
    }
    if (!projectFile && await lstat(projectAbsolute).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")) issues.push({ kind: "unreadable", path: slash(relative(projectDir, projectAbsolute)), detail: "Native project metadata appeared during inspection" });
  }
  const keyFor = (path: string) => (path === "/" ? "/" : path);
  const sheets = partial.map((sheet) => ({
    ...sheet,
    components:
      componentsBySheet.get(keyFor(sheet.hierarchyPath)) ??
      (partial.length === 1 ? componentsBySheet.get("/") : undefined) ??
      0,
    nets:
      (
        netsBySheet.get(keyFor(sheet.hierarchyPath)) ??
        (partial.length === 1 ? netsBySheet.get("/") : undefined)
      )?.size ?? 0,
  }));
  const aggregateRevision = hash(
    [...sheets.map(
        (sheet) =>
          `${sheet.hierarchyPath}\0${sheet.nativePath}\0${sheet.identity}\0${sheet.sha256}`,
      ), ...(opts.ownedFilesOnly && projectFile && ownedFiles.has(projectFile) ? [`project\0${projectFile}\0${hash(ownedFiles.get(projectFile)!)}`] : [])]
      .sort()
      .join("\n"),
  );
  const complete = issues.length === 0 && counts.sheets === sheets.length;
  return {
    rootFile,
    projectFile,
    aggregateRevision,
    complete,
    counts,
    sheets,
    referencedFiles: [...referencedFiles].sort(),
    orphanFiles,
    issues,
    source: {
      hierarchy: "native-kicad-project",
      electrical: "packaged-kicad-cli-netlist",
      kicadCli: { path: cli.path, version: cli.version },
    },
  };
}
