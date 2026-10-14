/**
 * Compare two git revisions (or the worktree) of a board: structured part/net/track
 * diff plus generated PCB/schematic SVGs. Writes reports/board-diff.json and renders/diff/*.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import {
  compareRevisions,
  diffSummary,
  type RevisionSources,
} from "@fabdesk/board-diff";
import { PROJECT_FILES, exists, writeJson } from "../fs";
import { ToolError, defineTool, type ProjectHandle } from "../registry";
import { ok, p } from "./common";

const WORKTREE = "worktree";

const REF_RE = /^(?:worktree|HEAD(?:[:~^][0-9a-zA-Z/_-]+)?|[0-9a-f]{7,40}|[A-Za-z][A-Za-z0-9._/-]*)$/;

export function assertGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (!REF_RE.test(trimmed) || trimmed.includes("..") || trimmed.includes("\0")) {
    throw new ToolError(`invalid git revision: ${ref}`, "invalid_args");
  }
  return trimmed;
}

async function git(
  dir: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
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
  const rel = relative(resolve(result.stdout.trim()), resolve(dir)).replaceAll("\\", "/");
  if (!rel || rel === "." || rel.startsWith("..")) return "";
  return rel;
}

function toGitPath(projectRel: string, prefix: string): string {
  return prefix ? `${prefix}/${projectRel}` : projectRel;
}

async function gitShow(
  dir: string,
  ref: string,
  path: string,
  signal?: AbortSignal,
  prefix = "",
): Promise<string | undefined> {
  const result = await git(dir, ["show", `${ref}:${toGitPath(path, prefix)}`], signal);
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
): Promise<{ sources: RevisionSources; paths: DesignPaths; commit?: string }> {
  if (ref === WORKTREE) {
    const paths = pickDesignPaths(await walkFiles(project.dir));
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
  const paths = pickDesignPaths(await listTree(project.dir, ref, signal, prefix));
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

export const board_revision_list = defineTool({
  name: "board_revision_list",
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
    if (await isGitRepo(project.dir, ctx.signal)) {
      const log = await git(project.dir, ["log", `-n${limit}`, "--format=%H\t%s\t%cI"], ctx.signal);
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
        ? "Project is not a git checkout; only the current worktree is available."
        : `${revisions.length - 1} git revision(s) plus the worktree.`,
      { revisions },
    );
  },
});

export const board_revision_diff = defineTool({
  name: "board_revision_diff",
  toolset: "kicad",
  title: "Visual board revision diff",
  description:
    "Compare two git revisions of this board (default: HEAD → worktree). Highlights added/removed/moved components, net membership changes, and copper/schematic tracks. Writes reports/board-diff.json and renders/diff/{pcb,schematic}-{structured,overlay,side-by-side}.svg. `from`/`to` are git refs or `worktree`.",
  inputSchema: {
    from: z.string().min(1).default("HEAD").describe("Older git ref, or `worktree`."),
    to: z.string().min(1).default(WORKTREE).describe("Newer git ref, or `worktree`."),
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
    if (fromRef !== WORKTREE || toRef !== WORKTREE) {
      if (!(await isGitRepo(project.dir, ctx.signal))) {
        throw new ToolError(
          "This project is not a git checkout. Import or clone the board, or pass from=worktree and to=worktree after saving two snapshots yourself.",
          "precondition",
        );
      }
    }
    ctx.progress(0.15, "reading revisions");
    const [fromRev, toRev] = await Promise.all([
      readRevisionSources(project, fromRef, ctx.signal),
      readRevisionSources(project, toRef, ctx.signal),
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
    const dir = p(project, PROJECT_FILES.renders, "diff");
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = {
      pcbStructured: "renders/diff/pcb-structured.svg",
      schematicStructured: "renders/diff/schematic-structured.svg",
    };
    await writeFile(join(project.dir, files.pcbStructured!), compared.pcb.structured);
    await writeFile(join(project.dir, files.schematicStructured!), compared.schematic.structured);
    files.pcbOverlay = "renders/diff/pcb-overlay.svg";
    files.pcbSideBySide = "renders/diff/pcb-side-by-side.svg";
    files.schematicOverlay = "renders/diff/schematic-overlay.svg";
    files.schematicSideBySide = "renders/diff/schematic-side-by-side.svg";
    await writeFile(join(project.dir, files.pcbOverlay), compared.pcb.overlay);
    await writeFile(join(project.dir, files.pcbSideBySide), compared.pcb.sideBySide);
    await writeFile(join(project.dir, files.schematicOverlay), compared.schematic.overlay);
    await writeFile(join(project.dir, files.schematicSideBySide), compared.schematic.sideBySide);
    const report = {
      from: { ref: fromRef, ...(fromRev.commit ? { commit: fromRev.commit } : {}), paths: fromRev.paths },
      to: { ref: toRef, ...(toRev.commit ? { commit: toRev.commit } : {}), paths: toRev.paths },
      summary,
      diff: compared.diff,
      files,
      text: compared.text,
    };
    await writeJson(p(project, PROJECT_FILES.reports, "board-diff.json"), report);
    ctx.progress(1, "done");
    return ok(`Board diff ${fromRef} → ${toRef}\n${compared.text}\nWrote reports/board-diff.json`, report);
  },
});

export const boardDiffTools = [board_revision_list, board_revision_diff];
