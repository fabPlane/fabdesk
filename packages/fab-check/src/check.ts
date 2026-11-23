import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGerber } from "@fabdesk/board-art";
import { checkBomPnp } from "./bom";
import { checkClearance } from "./clearance";
import { checkCompleteness } from "./completeness";
import { checkDesignConsistency, hashPackage, parseBoardOutline, parseDesignParts, countCopperLayers } from "./design";
import { checkOutline } from "./outline";
import { loadPackageFromDir, loadPackageFromFiles, loadPackageFromZip, type LoadedPackage } from "./package";
import { resolveRules } from "./profiles";
import { layerRenders } from "./render";
import { checkSilk } from "./silk";
import type {
  CheckOptions,
  CheckVerdict,
  FabCheckFinding,
  FabCheckReport,
  FabCheckSection,
  PackageFile,
} from "./types";
import { FAB_CHECK_LAYER_DIR } from "./types";

export async function checkFabPackage(
  input: { zip?: Uint8Array; dir?: string; files?: readonly PackageFile[]; source?: string },
  opts: CheckOptions = {},
): Promise<FabCheckReport> {
  const loaded = await loadInput(input);
  const design = enrichDesign(opts.design);
  const rules = resolveRules(opts.fab ?? "generic", opts);
  const packageHash = hashPackage(loaded.files);
  const expectedCopper = design?.copperLayers;
  const completeness = checkCompleteness({
    files: loaded.classified,
    allNames: loaded.files.map((f) => f.name),
    rules,
    ...(expectedCopper ? { expectedCopperLayers: expectedCopper } : {}),
  });
  const clearance = checkClearance({ files: loaded.classified, rules });
  const silk = checkSilk({ files: loaded.classified, rules });
  const outline = checkOutline({ files: loaded.classified, ...(design ? { design } : {}) });
  const bom = checkBomPnp({
    ...(loaded.bomCsv ? { bomCsv: loaded.bomCsv } : {}),
    ...(loaded.posCsv ? { posCsv: loaded.posCsv } : {}),
    ...(design ? { design } : {}),
    rules,
  });
  const designCheck = checkDesignConsistency({ packageHash, ...(design ? { design } : {}) });
  const written: string[] = [];
  const write = (rel: string, bytes: Uint8Array | string): string => {
    const path = `${opts.renderPrefix ?? FAB_CHECK_LAYER_DIR}/${rel}`;
    written.push(path);
    pendingWrites.push({ path, bytes });
    return path;
  };
  const pendingWrites: Array<{ path: string; bytes: Uint8Array | string }> = [];
  const renders = layerRenders(loaded.classified, write);
  if (opts.renderDir) {
    await mkdir(opts.renderDir, { recursive: true });
    for (const item of pendingWrites) {
      const abs = join(opts.renderDir, item.path.replace(/^.*\//, ""));
      await writeFile(abs, item.bytes);
    }
  }
  const checks: FabCheckSection[] = [completeness, clearance, silk, outline, bom, designCheck];
  const findings = checks.flatMap((c) => c.findings);
  const overall = overallOf(checks.map((c) => c.verdict));
  const copper = loaded.classified.filter((f) => f.kind === "copper");
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    overall,
    fab: rules.fab,
    rules,
    packageHash,
    source: loaded.source,
    layerCount: copper.length || expectedCopper || 2,
    files: loaded.files.map((f) => f.name),
    checks,
    findings,
    layers: loaded.classified.map((f) => {
      if (f.kind === "drill" || f.kind === "other")
        return { name: f.name, kind: f.kind, side: f.side, unit: null, ops: 0 };
      try {
        const parsed = parseGerber(f.body);
        return { name: f.name, kind: f.kind, side: f.side, unit: parsed.unit, ops: parsed.ops.length };
      } catch {
        return { name: f.name, kind: f.kind, side: f.side, unit: null, ops: 0 };
      }
    }),
    renders,
    notes: written.length ? [`Wrote ${written.length} layer render(s).`] : [],
  };
}

export function summarizeReport(report: FabCheckReport): string {
  const lines = [
    `Fab package check: ${report.overall.toUpperCase()} (${report.rules.label})`,
    `${report.files.length} file(s), ${report.layerCount} copper layer(s).`,
  ];
  for (const check of report.checks)
    lines.push(`- ${check.title}: ${check.verdict} — ${check.summary}`);
  const located = report.findings.filter((f) => f.x != null && f.y != null).slice(0, 8);
  if (located.length) {
    lines.push("Locations:");
    for (const f of located)
      lines.push(`  • ${f.message} @ ${f.x?.toFixed(2)}, ${f.y?.toFixed(2)}${f.layer ? ` (${f.layer})` : ""}`);
  }
  return lines.join("\n");
}

export function overallOf(verdicts: readonly CheckVerdict[]): "pass" | "warn" | "fail" {
  if (verdicts.includes("fail")) return "fail";
  if (verdicts.includes("warn")) return "warn";
  return "pass";
}

export function findingAt(findings: readonly FabCheckFinding[], id: string): FabCheckFinding | undefined {
  return findings.find((f) => f.id === id);
}

async function loadInput(input: {
  zip?: Uint8Array;
  dir?: string;
  files?: readonly PackageFile[];
  source?: string;
}): Promise<LoadedPackage> {
  if (input.files) return loadPackageFromFiles(input.files, input.source ?? "files");
  if (input.zip) return loadPackageFromZip(input.zip, input.source ?? "zip");
  if (input.dir) return loadPackageFromDir(input.dir, input.source ?? input.dir);
  throw new Error("fab package check needs a zip, directory or file list");
}

function enrichDesign(design: CheckOptions["design"]): CheckOptions["design"] {
  if (!design?.pcbText) return design;
  const parts = design.parts ?? parseDesignParts(design.pcbText);
  const outline = design.outline ?? parseBoardOutline(design.pcbText);
  return {
    ...design,
    ...(parts ? { parts } : {}),
    ...(outline ? { outline } : {}),
    copperLayers: design.copperLayers ?? countCopperLayers(design.pcbText),
  };
}
