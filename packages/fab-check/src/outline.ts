import { parseGerber } from "@fabdesk/board-art";
import { parseExcellon } from "./excellon";
import { almostEqual, boundsOfPoints, chainContours, pointInPolygon, rectSize, validRect } from "./geometry";
import type { ClassifiedFile, DesignSnapshot, FabCheckFinding, FabCheckSection } from "./types";

export function checkOutline(opts: {
  files: readonly ClassifiedFile[];
  design?: DesignSnapshot;
}): FabCheckSection {
  const findings: FabCheckFinding[] = [];
  const outline = opts.files.find((f) => f.kind === "outline");
  if (!outline) {
    return {
      id: "outline",
      title: "Board outline",
      verdict: "fail",
      summary: "No outline layer in the package.",
      findings: [{ id: "no-outline", check: "outline", severity: "fail", message: "No Edge.Cuts / profile Gerber." }],
    };
  }
  let parsed;
  try {
    parsed = parseGerber(outline.body);
  } catch (error) {
    return {
      id: "outline",
      title: "Board outline",
      verdict: "fail",
      summary: "Outline Gerber did not parse.",
      findings: [
        {
          id: "outline-parse",
          check: "outline",
          severity: "fail",
          message: error instanceof Error ? error.message : String(error),
          layer: outline.name,
        },
      ],
    };
  }
  const segs = parsed.ops
    .filter((op): op is Extract<typeof op, { op: "draw" }> => op.op === "draw")
    .map((op) => ({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }));
  const contours = chainContours(segs);
  const closed = contours.filter((c) => c.closed);
  if (closed.length === 0)
    findings.push({
      id: "outline-open",
      check: "outline",
      severity: "fail",
      message: "Board outline is not a closed contour.",
      layer: outline.name,
    });
  if (closed.length > 1)
    findings.push({
      id: "outline-multi",
      check: "outline",
      severity: "warn",
      message: `Found ${closed.length} closed contours; fabs expect a single outer outline (inner ones may be cutouts).`,
      layer: outline.name,
    });
  const outer = closed[0] ?? contours[0];
  const box = outer ? boundsOfPoints(outer.points) : null;
  const design = opts.design?.outline;
  if (box && validRect(box) && design) {
    const size = rectSize(box);
    if (!almostEqual(size.widthMm, design.widthMm, 0.15) || !almostEqual(size.heightMm, design.heightMm, 0.15))
      findings.push({
        id: "outline-size",
        check: "outline",
        severity: "fail",
        message: `Exported outline is ${size.widthMm.toFixed(2)} × ${size.heightMm.toFixed(2)} mm; KiCad Edge.Cuts is ${design.widthMm.toFixed(2)} × ${design.heightMm.toFixed(2)} mm.`,
        layer: outline.name,
      });
  }

  const poly = outer?.points ?? [];
  const drills = opts.files.filter((f) => f.kind === "drill");
  let slots = 0;
  let npth = 0;
  for (const file of drills) {
    const plated = /npth/i.test(file.name) ? false : /pth/i.test(file.name) ? true : null;
    const ex = parseExcellon(file.body, plated);
    for (const hit of ex.hits) {
      if (hit.slot) slots += 1;
      if (hit.plated === false) npth += 1;
      if (poly.length >= 3 && !pointInPolygon(hit, poly))
        findings.push({
          id: `drill-outside-${findings.length}`,
          check: "outline",
          severity: "fail",
          message: `Drill at ${hit.x.toFixed(2)}, ${hit.y.toFixed(2)} mm is outside the board outline.`,
          x: hit.x,
          y: hit.y,
          layer: file.name,
        });
    }
  }
  if (slots)
    findings.push({
      id: "slots",
      check: "outline",
      severity: "warn",
      message: `${slots} slot(s) in the drill files. Confirm the fab accepts routed slots.`,
    });
  if (npth)
    findings.push({
      id: "npth",
      check: "outline",
      severity: "warn",
      message: `${npth} non-plated hole(s) reported.`,
    });

  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    id: "outline",
    title: "Board outline",
    verdict: fails ? "fail" : findings.length ? "warn" : "pass",
    summary: fails
      ? "Outline is open, mismatched, or leaves drills outside the board."
      : closed.length === 1
        ? "Single closed outline; drills sit inside it."
        : "Outline parsed with notes.",
    findings: findings.slice(0, 40),
  };
}
