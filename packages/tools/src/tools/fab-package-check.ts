import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  FAB_CHECK_LAYER_DIR,
  FAB_CHECK_REPORT_FILE,
  checkFabPackage,
  hashPackage,
  loadPackageFromZip,
  parseFabId,
  summarizeReport,
  type DesignSnapshot,
  type FabCheckReport,
  type PackageFile,
} from "@fabdesk/fab-check";
import { PROJECT_FILES, ensureDir, exists, readJsonOrNull, writeAtomic, writeJson } from "../fs";
import { ToolError, defineTool, type ToolImage } from "../registry";
import { ok, p } from "./common";

export const fab_package_check = defineTool({
  name: "fab_package_check",
  toolset: "export",
  title: "Check fab package",
  description:
    "Inspect the exported manufacturing package itself (Gerbers, drill, BOM, pick-and-place) against the design and the chosen fab's rules. Checks package completeness, copper clearance, silkscreen over pads, outline closure, BOM/PnP cross-check, and DRC freshness. Renders every layer to reports/fab-check/layers for visual review. Intended for the exported zip or gerbers directory, as a last look at the files a fab house will receive.",
  inputSchema: {
    fab: z
      .enum(["generic", "jlcpcb", "pcbway"])
      .default("generic")
      .describe("Fab profile for spacing, silk, and zip-layout rules. Default generic is 0.15 mm."),
    minSpacingMm: z
      .number()
      .positive()
      .optional()
      .describe("Override copper clearance in mm (for example 0.15)."),
    minTraceMm: z.number().positive().optional().describe("Override minimum trace width in mm."),
    source: z
      .enum(["auto", "zip", "gerbers"])
      .default("auto")
      .describe("auto: exports/fabrication.zip when present, otherwise exports/gerbers/."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => {
    const project = ctx.requireProject();
    ctx.progress(0.1, "loading fabrication package");
    const pack = await loadProjectPackage(project.dir, args.source);
    if (pack.files.length === 0)
      throw new ToolError(
        "No fabrication package found. Export gerbers or a fabrication zip first.",
        "precondition",
      );
    const design = await loadDesignSnapshot(project.dir);
    const renderDir = await ensureDir(p(project, FAB_CHECK_LAYER_DIR));
    ctx.progress(0.4, "checking exported files");
    const report = await checkFabPackage(
      { files: pack.files, source: pack.source },
      {
        fab: parseFabId(args.fab),
        ...(args.minSpacingMm != null ? { minSpacingMm: args.minSpacingMm } : {}),
        ...(args.minTraceMm != null ? { minTraceMm: args.minTraceMm } : {}),
        ...(design ? { design } : {}),
        renderDir,
        renderPrefix: FAB_CHECK_LAYER_DIR,
      },
    );
    await persistRenders(project.dir, report);
    await writeJson(p(project, FAB_CHECK_REPORT_FILE), report);
    ctx.progress(1, "done");
    const images = report.renders
      .filter((r) => r.layer.includes("composite") || r.kind === "copper" || r.kind === "silk")
      .slice(0, 6)
      .map((r): ToolImage => ({ path: p(project, r.pngPath), mime: "image/png" }));
    const fail = report.overall === "fail";
    return ok(summarizeReport(report), report, {
      images,
      ...(fail ? { isError: true } : {}),
    });
  },
});

export async function loadProjectPackage(
  projectDir: string,
  source: "auto" | "zip" | "gerbers" = "auto",
): Promise<{ files: PackageFile[]; source: string; hash: string }> {
  const zipPath = join(projectDir, PROJECT_FILES.exports, "fabrication.zip");
  const gerberDir = join(projectDir, PROJECT_FILES.exports, "gerbers");
  const useZip = source === "zip" || (source === "auto" && (await exists(zipPath)));
  const files: PackageFile[] = [];
  if (useZip && (await exists(zipPath))) {
    const bytes = new Uint8Array(await Bun.file(zipPath).arrayBuffer());
    const loaded = loadPackageFromZip(bytes, "exports/fabrication.zip");
    return { files: loaded.files, source: loaded.source, hash: hashPackage(loaded.files) };
  }
  if (await exists(gerberDir)) {
    for (const name of await readdir(gerberDir)) {
      const abs = join(gerberDir, name);
      if (!(await stat(abs)).isFile()) continue;
      files.push({
        name: `gerbers/${name}`,
        bytes: new Uint8Array(await Bun.file(abs).arrayBuffer()),
      });
    }
  }
  for (const extra of ["bom.csv", "positions.csv"]) {
    const abs = join(projectDir, PROJECT_FILES.exports, extra);
    if (await exists(abs))
      files.push({ name: extra, bytes: new Uint8Array(await Bun.file(abs).arrayBuffer()) });
  }
  return { files, source: "exports/gerbers", hash: hashPackage(files) };
}

async function loadDesignSnapshot(projectDir: string): Promise<DesignSnapshot | undefined> {
  const board = join(projectDir, PROJECT_FILES.boardPcb);
  if (!(await exists(board))) return undefined;
  const pcbText = await Bun.file(board).text();
  const drc = await readJsonOrNull<{
    counts?: { errors?: number; warnings?: number };
    pcbRevision?: { sha256?: string };
  }>(join(projectDir, PROJECT_FILES.reports, "drc.json"));
  const { createHash } = await import("node:crypto");
  const pcbRevision = createHash("sha256").update(pcbText).digest("hex");
  const stale = typeof drc?.pcbRevision?.sha256 === "string" && drc.pcbRevision.sha256 !== pcbRevision;
  return {
    pcbText,
    pcbRevision,
    ...(drc
      ? {
          drc: {
            errors: drc.counts?.errors ?? 0,
            warnings: drc.counts?.warnings ?? 0,
            ...(stale ? { stale: true } : {}),
          },
        }
      : {}),
  };
}

async function persistRenders(projectDir: string, report: FabCheckReport): Promise<void> {
  for (const render of report.renders) {
    await writeAtomic(join(projectDir, render.svgPath), render.svg);
  }
}

export async function loadFabCheckEvidence(projectDir: string): Promise<{
  report: FabCheckReport;
  inputsChanged: boolean;
} | null> {
  const report = await readJsonOrNull<FabCheckReport>(join(projectDir, FAB_CHECK_REPORT_FILE));
  if (!report || report.version !== 1) return null;
  const pack = await loadProjectPackage(projectDir, "auto");
  if (pack.files.length === 0) return { report, inputsChanged: false };
  return { report, inputsChanged: pack.hash !== report.packageHash };
}
