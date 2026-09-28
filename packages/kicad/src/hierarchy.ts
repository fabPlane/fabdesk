import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  const blocks: string[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let sheetStart = -1;
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
      if (depth === 1 && /^\(sheet(?:\s|\r|\n)/.test(text.slice(index, index + 16)))
        sheetStart = index;
      depth++;
    } else if (character === ")") {
      depth--;
      if (depth < 0) throw new Error("unbalanced closing parenthesis");
      if (sheetStart >= 0 && depth === 1) {
        blocks.push(text.slice(sheetStart, index + 1));
        sheetStart = -1;
      }
    }
  }
  if (quoted || depth !== 0) throw new Error("unterminated string or unbalanced parentheses");
  const rootIdentity = /\(uuid\s+"([^"]+)"\)/.exec(text)?.[1] ?? "unknown";
  const sheets = blocks.map((block) => {
    const property = (key: string) => {
      const match = new RegExp(`\\(property\\s+"${key}"\\s+"((?:\\\\.|[^"])*)"`).exec(block);
      return match?.[1] ? unquote(match[1]) : undefined;
    };
    const filename = property("Sheetfile");
    if (!filename)
      throw new Error(
        `sheet ${uuid(/\(uuid\s+"([^"]+)"\)/.exec(block)?.[1])} has no Sheetfile property`,
      );
    return {
      filename,
      name: property("Sheetname") ?? basename(filename, extname(filename)),
      identity: /\(uuid\s+"([^"]+)"\)/.exec(block)?.[1] ?? "unknown",
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
  opts: { projectDir: string; rootSchematic: string; projectFile?: string; signal?: AbortSignal },
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
  let top: TopLevelSheet[] = [];
  if (projectFile) {
    try {
      top = await parseProject(projectAbsolute);
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
      data = await readFile(item.absolute);
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
      const xml = await exportRoot(
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
    sheets
      .map(
        (sheet) =>
          `${sheet.hierarchyPath}\0${sheet.nativePath}\0${sheet.identity}\0${sheet.sha256}`,
      )
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
