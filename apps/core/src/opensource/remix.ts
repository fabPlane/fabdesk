/**
 * Remix a catalog clone into a fabPlane project: adopt the cloned `.kicad_pcb` as the project
 * board and render `renders/pcb.svg` with kicad-cli so the PCB tab shows it without a chat turn.
 */
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { OpenCatalogEntry, RemixResult } from "@fabdesk/protocol";
import { PROJECT_FILES, type CoreServices, type ProjectHandle } from "@fabdesk/tools";
import { logger } from "../log";
import type { ProjectStore } from "../projects";

const SKIP_PCB = /(^|\/)(\.git|-backups|recovery|libraries)(\/|$)/i;
const SKIP_WALK_DIR = new Set([".git", "node_modules", "-backups", "recovery", "libraries"]);

export function pickKicadPcb(files: readonly { path: string }[], preferredStem?: string): string | undefined {
  const pcbs = files
    .map((f) => f.path)
    .filter((p) => p.toLowerCase().endsWith(".kicad_pcb") && !SKIP_PCB.test(p));
  if (pcbs.length === 0) return undefined;
  const stem = preferredStem?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const score = (path: string): number => {
    const parts = path.split("/");
    const base = (parts[parts.length - 1] ?? "").replace(/\.kicad_pcb$/i, "").toLowerCase();
    const depth = parts.length;
    let s = 0;
    if (stem && (base === stem || base.includes(stem) || stem.includes(base))) {
      s += base === stem ? 200 : 150;
    }
    if (depth === 1) s += 40;
    if (base === "board") s += 20;
    s -= depth * 5;
    return s;
  };
  return [...pcbs].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

/** Walk the clone for `.kicad_pcb` files so hydration is not limited by `listFiles` (max 2000). */
export async function listKicadPcbFiles(root: string, max = 200): Promise<{ path: string }[]> {
  const out: { path: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    if (out.length >= max) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= max) return;
      if (SKIP_WALK_DIR.has(e.name)) continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".kicad_pcb")) continue;
      const path = relative(root, abs).split(sep).join("/");
      if (!SKIP_PCB.test(path)) out.push({ path });
    }
  };
  await walk(root);
  return out;
}

export async function hydrateClonedBoard(opts: {
  project: ProjectHandle;
  files: readonly { path: string }[];
  /** Resolves `kicad-cli`, or null; with it the PCB tab gets a rendered `renders/pcb.svg`. */
  resolveCli: CoreServices["kicad"]["resolveCli"];
  exportPcbSvg: CoreServices["kicad"]["exportPcbSvg"];
  boardStats: CoreServices["kicad"]["boardStats"];
}): Promise<{ pcbPath: string } | null> {
  const pcbPath = pickKicadPcb(opts.files, opts.project.name);
  if (!pcbPath) return null;
  try {
    const abs = join(opts.project.dir, pcbPath);
    const target = join(opts.project.dir, PROJECT_FILES.boardPcb);
    const pcbSha256 = createHash("sha256").update(await readFile(abs)).digest("hex");
    if (abs !== target) await copyFile(abs, target);
    for (const [ext, dest] of [
      [".kicad_pro", PROJECT_FILES.boardPro],
      [".kicad_sch", PROJECT_FILES.boardSch],
    ] as const) {
      const sibling = abs.replace(/\.kicad_pcb$/i, ext);
      const to = join(opts.project.dir, dest);
      if (sibling !== to && (await stat(sibling).catch(() => null))) await copyFile(sibling, to);
    }
    await opts.project.updateManifest({ importedBoard: { path: pcbPath, adoptedAt: new Date().toISOString(), pcbSha256 } });
    const cli = await opts.resolveCli();
    if (cli) {
      const stats = (await opts.boardStats(cli, { board: target, scratchFile: join(opts.project.dir, PROJECT_FILES.reports, "stats.json") }).catch(() => ({}))) as Record<string, unknown>;
      const layers = Number(stats["copperLayers"] ?? stats["copper_layers"] ?? stats["layers"]);
      if (Number.isInteger(layers) && layers >= 1 && layers <= 8) await opts.project.updateManifest({ board: { ...opts.project.manifest().board, layers } });
      try {
        await mkdir(join(opts.project.dir, PROJECT_FILES.renders), { recursive: true });
        await opts.exportPcbSvg(cli, { board: target, output: join(opts.project.dir, PROJECT_FILES.renders, "pcb.svg") });
      } catch (e) {
        logger.warn("remix pcb svg failed", { error: e instanceof Error ? e.message : String(e), pcbPath });
      }
    }
    return { pcbPath };
  } catch (e) {
    logger.warn("remix board adopt failed", { error: e instanceof Error ? e.message : String(e), pcbPath });
    return null;
  }
}

export async function remixCatalogProject(opts: {
  source: Pick<OpenCatalogEntry, "id" | "name" | "cloneUrl">;
  projects: ProjectStore;
  services: Pick<CoreServices, "kicad">;
  clone?: (url: string, dir: string) => Promise<void>;
}): Promise<RemixResult> {
  const created = await opts.projects.importFromGit({
    name: opts.source.name,
    gitUrl: opts.source.cloneUrl,
    ...(opts.clone ? { clone: opts.clone } : {}),
  });
  const handle = await opts.projects.handle(created.id);
  let pcbPath: string | undefined;
  if (handle) {
    const files = await listKicadPcbFiles(handle.dir);
    const hydrated = await hydrateClonedBoard({
      project: handle,
      files,
      resolveCli: () => opts.services.kicad.resolveCli(),
      exportPcbSvg: (cli, o) => opts.services.kicad.exportPcbSvg(cli, o),
      boardStats: (cli, o) => opts.services.kicad.boardStats(cli, o),
    });
    pcbPath = hydrated?.pcbPath;
  }
  const detail = (await opts.projects.detail(created.id)) ?? created;
  return {
    project: detail,
    sourceId: opts.source.id,
    ...(pcbPath ? { pcbPath } : {}),
  };
}
