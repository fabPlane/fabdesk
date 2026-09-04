/**
 * Remix a catalog clone into a Fabdesk project and hydrate the board viewer
 * from the cloned `.kicad_pcb` so the PCB tab can render without a chat turn.
 */
import { join } from "node:path";
import type { OpenCatalogEntry, RemixResult } from "@fabdesk/protocol";
import { PROJECT_FILES, writeAtomic, writeJson, type CoreServices, type ProjectHandle } from "@fabdesk/tools";
import { logger } from "../log";
import type { ProjectStore } from "../projects";

const SKIP_PCB = /(^|\/)(\.git|-backups|recovery|libraries)(\/|$)/i;

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
    if (depth === 1) s += 100;
    if (stem && (base === stem || base.includes(stem) || stem.includes(base))) s += 50;
    if (base === "board") s += 20;
    s -= depth * 5;
    return s;
  };
  return [...pcbs].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

export async function hydrateClonedBoard(opts: {
  project: ProjectHandle;
  files: readonly { path: string }[];
  importPcb: CoreServices["kicad"]["importPcb"];
  pcbSvg: CoreServices["tscircuit"]["pcbSvg"];
}): Promise<{ pcbPath: string } | null> {
  const pcbPath = pickKicadPcb(opts.files, opts.project.name);
  if (!pcbPath) return null;
  try {
    const { circuitJson, report } = await opts.importPcb({
      pcbPath: join(opts.project.dir, pcbPath),
      projectName: opts.project.name,
      strict: false,
    });
    await writeJson(join(opts.project.dir, PROJECT_FILES.circuitJson), circuitJson);
    const rules = report.designRules;
    const board = {
      ...opts.project.manifest().board,
      layers: report.layers.copperCount,
      ...(report.board.widthMm ? { widthMm: report.board.widthMm } : {}),
      ...(report.board.heightMm ? { heightMm: report.board.heightMm } : {}),
      ...(rules
        ? {
            rules: {
              ...(rules.traceWidthMm !== undefined ? { traceWidthMm: rules.traceWidthMm } : {}),
              ...(rules.clearanceMm !== undefined ? { clearanceMm: rules.clearanceMm } : {}),
              ...(rules.viaDrillMm !== undefined ? { viaDrillMm: rules.viaDrillMm } : {}),
              ...(rules.viaDiameterMm !== undefined ? { viaDiameterMm: rules.viaDiameterMm } : {}),
            },
          }
        : {}),
    };
    await opts.project.updateManifest({ board });
    try {
      const svg = opts.pcbSvg(circuitJson);
      await writeAtomic(join(opts.project.dir, PROJECT_FILES.renders, "pcb.svg"), svg);
    } catch (e) {
      logger.warn("remix pcb svg failed", { error: e instanceof Error ? e.message : String(e), pcbPath });
    }
    return { pcbPath };
  } catch (e) {
    logger.warn("remix kicad import failed", { error: e instanceof Error ? e.message : String(e), pcbPath });
    return null;
  }
}

export async function remixCatalogProject(opts: {
  source: Pick<OpenCatalogEntry, "id" | "name" | "cloneUrl">;
  projects: ProjectStore;
  services: Pick<CoreServices, "kicad" | "tscircuit">;
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
    const hydrated = await hydrateClonedBoard({
      project: handle,
      files: created.files,
      importPcb: (o) => opts.services.kicad.importPcb(o),
      pcbSvg: (cj) => opts.services.tscircuit.pcbSvg(cj),
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
