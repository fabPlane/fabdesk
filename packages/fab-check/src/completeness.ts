import { parseGerber } from "@fabdesk/board-art";
import { parseExcellon } from "./excellon";
import type { ClassifiedFile, FabCheckFinding, FabCheckSection, FabRules } from "./types";

export function checkCompleteness(opts: {
  files: readonly ClassifiedFile[];
  allNames: readonly string[];
  rules: FabRules;
  expectedCopperLayers?: number;
}): FabCheckSection {
  const findings: FabCheckFinding[] = [];
  const copper = opts.files.filter((f) => f.kind === "copper");
  const mask = opts.files.filter((f) => f.kind === "mask");
  const paste = opts.files.filter((f) => f.kind === "paste");
  const silk = opts.files.filter((f) => f.kind === "silk");
  const outline = opts.files.filter((f) => f.kind === "outline");
  const drill = opts.files.filter((f) => f.kind === "drill");
  const expected = opts.expectedCopperLayers ?? Math.max(2, copper.length);

  const need = (ok: boolean, id: string, message: string) => {
    if (!ok) findings.push({ id, check: "completeness", severity: "fail", message });
  };
  need(copper.some((f) => f.side === "top"), "missing-f-cu", "Top copper layer is missing.");
  need(copper.some((f) => f.side === "bottom"), "missing-b-cu", "Bottom copper layer is missing.");
  if (expected > 2) {
    const inners = copper.filter((f) => f.side === "inner").length;
    need(inners >= expected - 2, "missing-inner-cu", `Expected ${expected - 2} inner copper layer(s); found ${inners}.`);
  }
  need(mask.some((f) => f.side === "top"), "missing-f-mask", "Top soldermask layer is missing.");
  need(mask.some((f) => f.side === "bottom"), "missing-b-mask", "Bottom soldermask layer is missing.");
  need(silk.length > 0, "missing-silk", "No silkscreen layer was found.");
  need(outline.length > 0, "missing-outline", "Board outline (Edge.Cuts / profile) is missing.");
  need(drill.length > 0, "missing-drill", "No Excellon drill file was found.");
  if (paste.length === 0)
    findings.push({
      id: "missing-paste",
      check: "completeness",
      severity: "warn",
      message: "No solder-paste layer was found (needed for SMT stencil / assembly).",
    });

  const units = new Set<string>();
  const formats = new Set<string>();
  for (const file of opts.files.filter((f) => f.kind !== "drill" && f.kind !== "other")) {
    try {
      const parsed = parseGerber(file.body);
      if (parsed.unit) units.add(parsed.unit);
      if (parsed.format) formats.add(`${parsed.format.int}.${parsed.format.frac}`);
      if (parsed.ops.length === 0 && file.kind !== "silk" && file.kind !== "paste")
        findings.push({
          id: `empty-${file.name}`,
          check: "completeness",
          severity: "warn",
          message: `${file.name} parsed but contains no flashes, draws or regions.`,
          layer: file.name,
        });
    } catch (error) {
      findings.push({
        id: `parse-${file.name}`,
        check: "completeness",
        severity: "fail",
        message: `${file.name} is not valid RS-274X: ${error instanceof Error ? error.message : String(error)}`,
        layer: file.name,
      });
    }
  }
  for (const file of drill) {
    try {
      const parsed = parseExcellon(file.body, /npth/i.test(file.name) ? false : true);
      if (parsed.hits.length === 0)
        findings.push({
          id: `empty-drill-${file.name}`,
          check: "completeness",
          severity: "warn",
          message: `${file.name} parsed but contains no drill hits.`,
          layer: file.name,
        });
    } catch (error) {
      findings.push({
        id: `parse-drill-${file.name}`,
        check: "completeness",
        severity: "fail",
        message: `${file.name} is not valid Excellon: ${error instanceof Error ? error.message : String(error)}`,
        layer: file.name,
      });
    }
  }
  if (units.size > 1)
    findings.push({
      id: "unit-mismatch",
      check: "completeness",
      severity: "fail",
      message: `Gerber units are mixed (${[...units].join(", ")}).`,
    });
  if (formats.size > 1)
    findings.push({
      id: "format-mismatch",
      check: "completeness",
      severity: "warn",
      message: `Gerber coordinate formats differ (${[...formats].join(", ")}).`,
    });

  const names = opts.allNames.map((n) => n.replace(/\\/g, "/"));
  const hasGerber = names.some((n) => /\.gbr$/i.test(n) || /gerbers\//i.test(n));
  if (!hasGerber)
    findings.push({
      id: "zip-layout",
      check: "completeness",
      severity: "warn",
      message: `${opts.rules.label} usually expects Gerber files (*.gbr) in the archive.`,
    });

  const fails = findings.filter((f) => f.severity === "fail").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  return {
    id: "completeness",
    title: "Package completeness",
    verdict: fails ? "fail" : warns ? "warn" : "pass",
    summary: fails
      ? `${fails} required manufacturing file(s) are missing or unreadable.`
      : warns
        ? "Package is readable; optional layers or format notes remain."
        : `Copper, mask, silk, outline and drill files are present for a ${expected}-layer board.`,
    findings,
  };
}
