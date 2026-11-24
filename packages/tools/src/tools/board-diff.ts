/**
 * Compare two git revisions (or the worktree) of a board: structured part/net/track
 * diff plus generated PCB/schematic SVGs. Writes reports/board-diff.json and renders/diff/*.
 */
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { ASSEMBLY_MANIFEST_PATH, BoardSourceSelection, ProjectAssembly } from "@fabdesk/protocol";
import {
  compareRevisions,
  diffSummary,
  type RevisionSources,
} from "@fabdesk/board-diff";
import { PROJECT_FILES, exists, jailPath, writeAtomic, writeJson } from "../fs";
import { ToolError, defineTool, type ProjectHandle, type ToolContext } from "../registry";
import { ok, p } from "./common";

const WORKTREE = "worktree";
const SAVED_REVISION = /^saved:[a-f0-9]{64}$/;
const SAVED_DIRECTORY = ".fabdesk/board-revisions";
const SavedRevision = z.object({
  contract: z.literal("fabplane.board-comparison-point.v1"),
  ref: z.string().regex(SAVED_REVISION), title: z.string(), date: z.string(),
  board: BoardSourceSelection.optional(),
  sources: z.object({ kicadPcb: z.string().optional(), kicadSch: z.string().optional(), netlistJson: z.unknown().optional(), pcbSvg: z.string().optional(), schematicSvg: z.string().optional() }),
});

const REF_RE = /^(?:worktree|HEAD(?:[:~^][0-9a-zA-Z/_-]+)?|[0-9a-f]{7,40}|[A-Za-z][A-Za-z0-9._/-]*)$/;

export function assertGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (SAVED_REVISION.test(trimmed)) return trimmed;
  if (!REF_RE.test(trimmed) || trimmed.includes("..") || trimmed.includes("\0")) {
    throw new ToolError(`invalid git revision: ${ref}`, "invalid_args");
  }
  return trimmed;
}

export async function git(
  dir: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
    ...(signal ? { signal } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout, stderr };
}

export async function isGitRepo(dir: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(dir, ["rev-parse", "--is-inside-work-tree"], signal);
  return result.ok && result.stdout.trim() === "true";
}

/** Project directory relative to the git toplevel (`""` when they are the same). */
export async function projectGitPrefix(dir: string, signal?: AbortSignal): Promise<string> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"], signal);
  if (!result.ok) return "";
  const rel = relative(await realpath(result.stdout.trim()), await realpath(dir)).replaceAll("\\", "/");
  if (!rel || rel === "." || rel.startsWith("..")) return "";
  return rel;
}

function toGitPath(projectRel: string, prefix: string): string {
  return prefix ? `${prefix}/${projectRel}` : projectRel;
}

export async function gitShow(
  dir: string,
  ref: string,
  path: string,
  signal?: AbortSignal,
  prefix = "",
): Promise<string | undefined> {
  // The trailing separator stops git from also statting this as a path, which fails on long paths.
  const result = await git(dir, ["show", `${ref}:${toGitPath(path, prefix)}`, "--"], signal);
  return result.ok ? result.stdout : undefined;
}

/**
 * `git ls-tree` is repo-root relative when the cwd is the toplevel, and
 * already scoped to the cwd on Git 2.43+ when `-C` is a subfolder. Normalize
 * either listing to project-relative paths so a sibling `.kicad_pcb` outside
 * the project cannot become the preferred-board fallback.
 */
export function projectRelGitPaths(paths: string[], prefix: string): string[] {
  if (!prefix) return paths;
  const pre = `${prefix}/`;
  const rooted = paths.filter((path) => path === prefix || path.startsWith(pre));
  if (rooted.length > 0) {
    return rooted.map((path) => (path === prefix ? "" : path.slice(pre.length))).filter(Boolean);
  }
  return paths;
}

async function listTree(dir: string, ref: string, signal?: AbortSignal, prefix = ""): Promise<string[]> {
  const result = await git(dir, ["ls-tree", "-r", "--name-only", ref], signal);
  if (!result.ok) return [];
  const files = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return projectRelGitPaths(files, prefix);
}

async function walkFiles(root: string, rel = ""): Promise<string[]> {
  const dir = rel ? join(root, rel) : root;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".fabdesk") continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkFiles(root, child)));
    else out.push(child);
  }
  return out;
}

/**
 * Pick a design file from a project-relative (or repo-relative) path list.
 * Matches the preferred path exactly, as a project-relative suffix, or by
 * basename before falling back to the first extension match inside the list.
 * Callers must already restrict `paths` to the project directory so a missing
 * preferred board is never compared against a PCB from a parent/sibling folder.
 */
export function pickDesignFile(paths: string[], preferred: string, ext: RegExp): string | undefined {
  if (paths.includes(preferred)) return preferred;
  const projectRel = paths.find((path) => path === preferred || path.endsWith(`/${preferred}`));
  if (projectRel) return projectRel;
  const prefBase = basename(preferred);
  const byBase = paths.find((path) => basename(path) === prefBase);
  if (byBase) return byBase;
  return paths.find((path) => ext.test(path) && !path.includes("/renders/"));
}

export type DesignPaths = { pcb?: string; schematic?: string; netlist?: string; pcbSvg?: string; schematicSvg?: string };

export function pickDesignPaths(paths: string[]): DesignPaths {
  const pcb = pickDesignFile(paths, PROJECT_FILES.boardPcb, /\.kicad_pcb$/i);
  const schematic = pickDesignFile(paths, PROJECT_FILES.boardSch, /\.kicad_sch$/i);
  const netlist = pickDesignFile(paths, PROJECT_FILES.netlistJson, /circuit\.netlist\.json$/i);
  const pcbSvg = pickDesignFile(paths, `${PROJECT_FILES.renders}/pcb.svg`, /(?:^|\/)pcb\.svg$/i);
  const schematicSvg = pickDesignFile(paths, `${PROJECT_FILES.renders}/schematic.svg`, /(?:^|\/)schematic\.svg$/i);
  return {
    ...(pcb ? { pcb } : {}),
    ...(schematic ? { schematic } : {}),
    ...(netlist ? { netlist } : {}),
    ...(pcbSvg ? { pcbSvg } : {}),
    ...(schematicSvg ? { schematicSvg } : {}),
  };
}

async function readRevisionSources(
  project: ProjectHandle,
  ref: string,
  signal?: AbortSignal,
  member = false,
): Promise<{ sources: RevisionSources; paths: DesignPaths; commit?: string }> {
  // A member is exactly its canonical source. Never borrow a nested board or an unverified netlist.
  const pick = (paths: string[]) => member ? Object.fromEntries([
    ["pcb", PROJECT_FILES.boardPcb], ["schematic", PROJECT_FILES.boardSch],
    ["pcbSvg", "renders/pcb.svg"], ["schematicSvg", "renders/schematic.svg"],
  ].filter((entry): entry is [string, string] => !!entry[1] && paths.includes(entry[1]))) as DesignPaths : pickDesignPaths(paths);
  if (ref === WORKTREE) {
    const paths = pick(await walkFiles(project.dir));
    const sources: RevisionSources = {};
    if (paths.netlist && (await exists(p(project, paths.netlist)))) {
      try {
        sources.netlistJson = JSON.parse(await readFile(p(project, paths.netlist), "utf8")) as unknown;
      } catch {
        /* ignore invalid netlist */
      }
    }
    if (paths.pcb && (await exists(p(project, paths.pcb)))) sources.kicadPcb = await readFile(p(project, paths.pcb), "utf8");
    if (paths.schematic && (await exists(p(project, paths.schematic)))) {
      sources.kicadSch = await readFile(p(project, paths.schematic), "utf8");
    }
    if (paths.pcbSvg && (await exists(p(project, paths.pcbSvg)))) sources.pcbSvg = await readFile(p(project, paths.pcbSvg), "utf8");
    if (paths.schematicSvg && (await exists(p(project, paths.schematicSvg)))) {
      sources.schematicSvg = await readFile(p(project, paths.schematicSvg), "utf8");
    }
    return { sources, paths };
  }

  const prefix = await projectGitPrefix(project.dir, signal);
  const paths = pick(await listTree(project.dir, ref, signal, prefix));
  const sources: RevisionSources = {};
  if (paths.netlist) {
    const raw = await gitShow(project.dir, ref, paths.netlist, signal, prefix);
    if (raw) {
      try {
        sources.netlistJson = JSON.parse(raw) as unknown;
      } catch {
        /* ignore */
      }
    }
  }
  if (paths.pcb) {
    const raw = await gitShow(project.dir, ref, paths.pcb, signal, prefix);
    if (raw) sources.kicadPcb = raw;
  }
  if (paths.schematic) {
    const raw = await gitShow(project.dir, ref, paths.schematic, signal, prefix);
    if (raw) sources.kicadSch = raw;
  }
  if (paths.pcbSvg) {
    const raw = await gitShow(project.dir, ref, paths.pcbSvg, signal, prefix);
    if (raw) sources.pcbSvg = raw;
  }
  if (paths.schematicSvg) {
    const raw = await gitShow(project.dir, ref, paths.schematicSvg, signal, prefix);
    if (raw) sources.schematicSvg = raw;
  }
  const commit = await git(project.dir, ["rev-parse", ref], signal);
  return {
    sources,
    paths,
    ...(commit.ok ? { commit: commit.stdout.trim() } : {}),
  };
}

async function savedRevision(ctx: ToolContext, ref: string) {
  const path = await jailPath(ctx.requireProject().dir, `${SAVED_DIRECTORY}/${ref.slice(6)}.json`);
  const raw = await readFile(path, "utf8").catch(() => { throw new ToolError("This comparison point is unavailable. Choose another saved revision.", "not_found"); });
  const parsed = SavedRevision.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.ref !== ref || parsed.data.board?.sourceId !== ctx.board?.sourceId)
    throw new ToolError("This comparison point does not belong to the selected board source.", "precondition");
  // Verify native bytes even if a comparison file was replaced outside the app.
  if (comparisonRef(parsed.data.sources as RevisionSources, parsed.data.board?.sourceId) !== ref)
    throw new ToolError("This comparison point changed. Its saved native sources cannot be verified.", "precondition");
  return parsed.data;
}

function comparisonRef(sources: RevisionSources, sourceId?: string): string {
  return `saved:${createHash("sha256").update(JSON.stringify({ sourceId: sourceId ?? null, pcb: sources.kicadPcb ?? null, schematic: sources.kicadSch ?? null, netlist: sources.netlistJson ?? null })).digest("hex")}`;
}

async function assertHistoricalMember(ctx: ToolContext, ref: string) {
  if (!ctx.board || ref === WORKTREE || SAVED_REVISION.test(ref)) return;
  if (!ctx.boardRoot) throw new ToolError("The host did not supply assembly history ownership.", "precondition");
  const root = ctx.boardRoot, prefix = await projectGitPrefix(root.dir, ctx.signal);
  const raw = await gitShow(root.dir, ref, ASSEMBLY_MANIFEST_PATH, ctx.signal, prefix);
  const declaration = ProjectAssembly.safeParse(raw ? JSON.parse(raw) : null);
  const source = declaration.success ? declaration.data.sources.find(source => source.id === ctx.board!.sourceId) : null;
  const directory = relative(root.dir, ctx.requireProject().dir).replaceAll("\\", "/") || ".";
  if (!source || source.location !== "project" || source.directory !== directory)
    throw new ToolError(`The selected board source is not declared at the same location in ${ref}. Choose a comparison point or a commit with matching source ownership.`, "precondition");
}

export const board_revision_checkpoint = defineTool({
  name: "board_revision_checkpoint", boardScoped: true, toolset: "kicad", title: "Save board comparison point",
  description: "Save current native PCB/schematic bytes as a local comparison point without Git or modifying the design. Returns a saved: reference accepted by board_revision_diff. Assembly members require an explicit captured board selector.",
  inputSchema: { label: z.string().trim().min(1).max(120).default("Saved comparison point") },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: async ({ label }, ctx) => {
    const { sources } = await readRevisionSources(ctx.requireProject(), WORKTREE, ctx.signal, !!ctx.board);
    if (!sources.kicadPcb && !sources.kicadSch && !sources.netlistJson) throw new ToolError("Add a native PCB or schematic before saving a comparison point.", "precondition");
    // Re-read native inputs so a mixed snapshot is never published while another edit saves.
    const ref = comparisonRef(sources, ctx.board?.sourceId);
    const after = await readRevisionSources(ctx.requireProject(), WORKTREE, ctx.signal, !!ctx.board);
    if (comparisonRef(after.sources, ctx.board?.sourceId) !== ref) throw new ToolError("The design changed while saving. Try again after the edit finishes.", "precondition");
    await ctx.runInScope?.(async () => {});
    const path = await jailPath(ctx.requireProject().dir, `${SAVED_DIRECTORY}/${ref.slice(6)}.json`);
    if (!(await exists(path))) await writeJson(path, { contract: "fabplane.board-comparison-point.v1", ref, title: label, date: new Date().toISOString(), sources, ...(ctx.board ? { board: ctx.board } : {}) });
    const saved = await savedRevision(ctx, ref);
    return ok("Saved a comparison point. Native design files are unchanged.", { revision: { ref: saved.ref, title: saved.title, date: saved.date } });
  },
});

export const board_revision_list = defineTool({
  name: "board_revision_list",
  boardScoped: true,
  toolset: "kicad",
  title: "List board revisions",
  description:
    "List git commits for the current project so board_revision_diff can compare two of them. Always includes `worktree` (unsaved / current files). Returns an empty commit list when the project is not a git checkout.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).default(40),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ limit }, ctx) => {
    const project = ctx.requireProject();
    const revisions: Array<{ ref: string; title: string; date?: string; commit?: string }> = [
      { ref: WORKTREE, title: "Current worktree" },
    ];
    const saved = await readdir(await jailPath(project.dir, SAVED_DIRECTORY)).catch(() => []);
    const points = await Promise.all(saved.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(async file => {
      try { const point = await savedRevision(ctx, `saved:${file.slice(0, -5)}`); return { ref: point.ref, title: point.title, date: point.date }; }
      catch { return null; }
    }));
    revisions.push(...points.filter(point => point !== null).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit));
    if (await isGitRepo(project.dir, ctx.signal)) {
      const log = await git(project.dir, ["log", `-n${limit}`, "--format=%H\t%s\t%cI", ...(ctx.board ? ["--", "board.kicad_pcb", "board.kicad_sch"] : [])], ctx.signal);
      if (log.ok) {
        for (const line of log.stdout.split("\n")) {
          if (!line.trim()) continue;
          const [commit, title, date] = line.split("\t");
          if (!commit) continue;
          revisions.push({
            ref: commit,
            title: title || commit.slice(0, 8),
            ...(date ? { date } : {}),
            commit,
          });
        }
      }
    }
    return ok(
      revisions.length === 1
        ? "No comparison point yet. Save one before editing, or use a project with Git history."
        : `${revisions.length - 1} saved comparison point(s) or Git revision(s), plus current files.`,
      { revisions },
    );
  },
});

export const board_revision_diff = defineTool({
  name: "board_revision_diff",
  boardScoped: true,
  toolset: "kicad",
  title: "Visual board revision diff",
  description:
    "Compare two git revisions of this board (default: HEAD → worktree). Highlights added/removed/moved components, net membership changes, and copper/schematic tracks. Writes reports/board-diff.json and renders/diff/{pcb,schematic}-{structured,overlay,side-by-side}.svg. `from`/`to` accept Git refs, saved comparison-point references, or `worktree`.",
  inputSchema: {
    from: z.string().min(1).default("HEAD").describe("Older Git ref, saved:<SHA-256> comparison point, or worktree."),
    to: z.string().min(1).default(WORKTREE).describe("Newer Git ref, saved:<SHA-256> comparison point, or worktree."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ from: fromRaw, to: toRaw }, ctx) => {
    const project = ctx.requireProject();
    const fromRef = assertGitRef(fromRaw);
    const toRef = assertGitRef(toRaw);
    if ([fromRef, toRef].some(ref => ref !== WORKTREE && !SAVED_REVISION.test(ref))) {
      if (!(await isGitRepo(project.dir, ctx.signal))) {
        throw new ToolError(
          "This project is not a git checkout. Import or clone the board, or pass from=worktree and to=worktree after saving two snapshots yourself.",
          "precondition",
        );
      }
    }
    ctx.progress(0.15, "reading revisions");
    await Promise.all([assertHistoricalMember(ctx, fromRef), assertHistoricalMember(ctx, toRef)]);
    const read = async (ref: string): Promise<{ sources: RevisionSources; paths: DesignPaths; commit?: string }> => SAVED_REVISION.test(ref) ? { sources: (await savedRevision(ctx, ref)).sources as RevisionSources, paths: {} } : readRevisionSources(project, ref, ctx.signal, !!ctx.board);
    const [fromRev, toRev] = await Promise.all([
      read(fromRef),
      read(toRef),
    ]);
    if (!fromRev.sources.kicadPcb && !fromRev.sources.kicadSch && !fromRev.sources.netlistJson) {
      throw new ToolError(`no board, schematic, or netlist at ${fromRef}`, "precondition");
    }
    if (!toRev.sources.kicadPcb && !toRev.sources.kicadSch && !toRev.sources.netlistJson) {
      throw new ToolError(`no board, schematic, or netlist at ${toRef}`, "precondition");
    }
    ctx.progress(0.55, "diffing");
    const compared = compareRevisions(fromRev.sources, toRev.sources);
    const summary = diffSummary(compared.diff);
    await ctx.runInScope?.(async () => {});
    const digest = createHash("sha256").update(JSON.stringify([fromRef, toRef, fromRev.sources, toRev.sources])).digest("hex").slice(0, 24);
    const artifactPrefix = `${PROJECT_FILES.renders}/diff/${digest}`;
    const dir = await jailPath(project.dir, artifactPrefix);
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = {
      pcbStructured: `${artifactPrefix}/pcb-structured.svg`,
      schematicStructured: `${artifactPrefix}/schematic-structured.svg`,
    };
    const publish = async (path: string, content: string) => writeAtomic(await jailPath(project.dir, path), content);
    await publish(files.pcbStructured!, compared.pcb.structured);
    await publish(files.schematicStructured!, compared.schematic.structured);
    files.pcbOverlay = `${artifactPrefix}/pcb-overlay.svg`;
    files.pcbSideBySide = `${artifactPrefix}/pcb-side-by-side.svg`;
    files.schematicOverlay = `${artifactPrefix}/schematic-overlay.svg`;
    files.schematicSideBySide = `${artifactPrefix}/schematic-side-by-side.svg`;
    await publish(files.pcbOverlay, compared.pcb.overlay);
    await publish(files.pcbSideBySide, compared.pcb.sideBySide);
    await publish(files.schematicOverlay, compared.schematic.overlay);
    await publish(files.schematicSideBySide, compared.schematic.sideBySide);
    const report = {
      from: { ref: fromRef, ...(fromRev.commit ? { commit: fromRev.commit } : {}), paths: fromRev.paths },
      to: { ref: toRef, ...(toRev.commit ? { commit: toRev.commit } : {}), paths: toRev.paths },
      summary,
      documents: { pcb: !!(fromRev.sources.kicadPcb || toRev.sources.kicadPcb), schematic: !!(fromRev.sources.kicadSch || toRev.sources.kicadSch) },
      diff: compared.diff,
      files,
      text: compared.text,
      ...(ctx.board ? { boardSource: { projectId: project.id, ...ctx.board } } : {}),
    };
    await ctx.runInScope?.(async () => {});
    await writeJson(await jailPath(project.dir, `${PROJECT_FILES.reports}/board-diff.json`), report);
    ctx.progress(1, "done");
    return ok(`Board diff ${fromRef} → ${toRef}\n${compared.text}\nWrote reports/board-diff.json`, report);
  },
});

export const boardDiffTools = [board_revision_list, board_revision_checkpoint, board_revision_diff];
