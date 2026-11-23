export type FabCheckVerdict = "pass" | "warn" | "fail" | "skip";

export type FabCheckFinding = {
  id: string;
  check: string;
  severity: "warn" | "fail";
  message: string;
  x?: number;
  y?: number;
  layer?: string;
  ref?: string;
};

export type FabCheckSection = {
  id: string;
  title: string;
  verdict: FabCheckVerdict;
  summary: string;
  findings: FabCheckFinding[];
};

export type FabCheckRender = {
  layer: string;
  kind: string;
  side: string;
  pngPath: string;
  svgPath: string;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
};

export type FabCheckReport = {
  version: 1;
  createdAt: string;
  overall: "pass" | "warn" | "fail";
  fab: string;
  rules: { label: string; minSpacingMm: number; minTraceMm: number };
  packageHash: string;
  source: string;
  layerCount: number;
  files: string[];
  checks: FabCheckSection[];
  findings: FabCheckFinding[];
  renders: FabCheckRender[];
};

export function isFabCheckReport(value: unknown): value is FabCheckReport {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r["version"] === 1 && typeof r["overall"] === "string" && Array.isArray(r["checks"]);
}

export function verdictTone(verdict: string): "success" | "warning" | "danger" | "neutral" {
  if (verdict === "pass") return "success";
  if (verdict === "warn") return "warning";
  if (verdict === "fail") return "danger";
  return "neutral";
}

export function chatSummary(report: FabCheckReport): { title: string; lines: string[] } {
  return {
    title: `Fab package ${report.overall}`,
    lines: report.checks.map((c) => `${c.title}: ${c.verdict}`),
  };
}

/** Place a finding marker over a Gerber-space render. Y grows downward, matching the raster. */
export function markerPercent(
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined,
  x: number,
  y: number,
): { left: string; top: string } {
  if (!bounds) return { left: "50%", top: "50%" };
  const w = Math.max(1e-6, bounds.maxX - bounds.minX);
  const h = Math.max(1e-6, bounds.maxY - bounds.minY);
  const left = ((x - bounds.minX) / w) * 100;
  const top = ((y - bounds.minY) / h) * 100;
  return {
    left: `${Math.min(100, Math.max(0, left))}%`,
    top: `${Math.min(100, Math.max(0, top))}%`,
  };
}
