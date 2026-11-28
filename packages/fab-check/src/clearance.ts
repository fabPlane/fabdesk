import { parseGerber, type ParsedGerber } from "@fabdesk/board-art";
import { fromPixel, gerberBounds, labelComponents, rasterizeGerber } from "./raster";
import type { ClassifiedFile, FabCheckFinding, FabCheckSection, FabRules } from "./types";

const MAX_FINDINGS = 40;

export function checkClearance(opts: {
  files: readonly ClassifiedFile[];
  rules: FabRules;
}): FabCheckSection {
  const findings: FabCheckFinding[] = [];
  const copper = opts.files.filter((f) => f.kind === "copper");
  for (const file of copper) {
    let parsed: ParsedGerber;
    try {
      parsed = parseGerber(file.body);
    } catch {
      continue;
    }
    findings.push(...thinTraces(parsed, file.name, opts.rules.minTraceMm));
    findings.push(...spacingViolations(parsed, file.name, opts.rules.minSpacingMm));
  }
  const shown = findings.slice(0, MAX_FINDINGS);
  const extra = findings.length - shown.length;
  if (extra > 0)
    shown.push({
      id: "clearance-truncated",
      check: "clearance",
      severity: "warn",
      message: `${extra} further copper clearance finding(s) omitted.`,
    });
  const fails = shown.filter((f) => f.severity === "fail").length;
  return {
    id: "clearance",
    title: "Copper clearance",
    verdict: fails ? "fail" : shown.length ? "warn" : copper.length ? "pass" : "skip",
    summary: fails
      ? `${fails} copper spacing or width violation(s) vs ${opts.rules.minSpacingMm} mm / ${opts.rules.minTraceMm} mm.`
      : copper.length
        ? `Exported copper meets ${opts.rules.label} ${opts.rules.minSpacingMm} mm spacing.`
        : "No copper layers to check.",
    findings: shown,
  };
}

function thinTraces(parsed: ParsedGerber, layer: string, minTraceMm: number): FabCheckFinding[] {
  const byId = new Map(parsed.apertures.map((a) => [a.id, a]));
  const out: FabCheckFinding[] = [];
  let n = 0;
  for (const op of parsed.ops) {
    if (op.op !== "draw") continue;
    const ap = byId.get(op.aperture);
    const width = ap?.kind === "C" ? ap.d : ap ? Math.min(ap.w, ap.h) : 0;
    if (width + 1e-9 >= minTraceMm) continue;
    n += 1;
    if (out.length >= 12) continue;
    out.push({
      id: `thin-${layer}-${n}`,
      check: "clearance",
      severity: "fail",
      message: `Trace width ${width.toFixed(3)} mm is below ${minTraceMm} mm on ${layer}.`,
      x: (op.x1 + op.x2) / 2,
      y: (op.y1 + op.y2) / 2,
      layer,
    });
  }
  return out;
}

function spacingViolations(
  parsed: ParsedGerber,
  layer: string,
  minSpacingMm: number,
): FabCheckFinding[] {
  const bounds = gerberBounds(parsed, minSpacingMm + 0.2);
  const scale = Math.min(80, Math.max(20, 4 / minSpacingMm));
  const raster = rasterizeGerber(parsed, { bounds, scale, maxPx: 1200 });
  for (let i = 0; i < raster.data.length; i++) if (raster.data[i]) raster.data[i] = 1;
  const count = labelComponents(raster);
  if (count < 2) return [];
  const radius = Math.max(1, Math.round(minSpacingMm * raster.scale));
  const seen = new Set<string>();
  const out: FabCheckFinding[] = [];
  const { width, height, data } = raster;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const id = data[y * width + x] ?? 0;
      if (id < 2) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const other = data[yy * width + xx] ?? 0;
          if (other < 2 || other === id) continue;
          const key = id < other ? `${id}:${other}` : `${other}:${id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pt = fromPixel(raster, x, y);
          out.push({
            id: `gap-${layer}-${key}`,
            check: "clearance",
            severity: "fail",
            message: `Copper features closer than ${minSpacingMm} mm on ${layer}.`,
            x: round4(pt.x),
            y: round4(pt.y),
            layer,
          });
          if (out.length >= 16) return out;
        }
      }
    }
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
