import { parseGerber, type ParsedGerber } from "@fabdesk/board-art";
import { chainContours, pointInPolygon } from "./geometry";
import { gerberBounds, rasterizeGerber, fromPixel } from "./raster";
import type { ClassifiedFile, FabCheckFinding, FabCheckSection, FabRules, Point } from "./types";

export function checkSilk(opts: {
  files: readonly ClassifiedFile[];
  rules: FabRules;
}): FabCheckSection {
  const findings: FabCheckFinding[] = [];
  const silk = opts.files.filter((f) => f.kind === "silk");
  const mask = opts.files.filter((f) => f.kind === "mask");
  const outline = opts.files.find((f) => f.kind === "outline");
  const outlinePoly = outline ? outlinePolygon(outline) : null;

  for (const file of silk) {
    let parsed: ParsedGerber;
    try {
      parsed = parseGerber(file.body);
    } catch {
      continue;
    }
    findings.push(...thinSilk(parsed, file.name, opts.rules));
    const maskFile = mask.find((m) => m.side === file.side) ?? mask[0];
    if (maskFile) findings.push(...silkOverMask(parsed, maskFile, file.name));
    if (outlinePoly && outlinePoly.length >= 3)
      findings.push(...silkOutside(parsed, outlinePoly, file.name));
  }

  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    id: "silk",
    title: "Silkscreen",
    verdict: fails ? "fail" : findings.length ? "warn" : silk.length ? "pass" : "skip",
    summary: fails
      ? `${fails} silkscreen issue(s) (over pads, thin features, or outside the outline).`
      : silk.length
        ? "Silkscreen stays off mask openings and inside the outline."
        : "No silkscreen layer to check.",
    findings: findings.slice(0, 40),
  };
}

function thinSilk(parsed: ParsedGerber, layer: string, rules: FabRules): FabCheckFinding[] {
  const out: FabCheckFinding[] = [];
  for (const ap of parsed.apertures) {
    const w = ap.kind === "C" ? ap.d : Math.min(ap.w, ap.h);
    const h = ap.kind === "C" ? ap.d : Math.max(ap.w, ap.h);
    if (w + 1e-9 < rules.minSilkWidthMm) {
      out.push({
        id: `silk-width-${layer}-${ap.id}`,
        check: "silk",
        severity: "fail",
        message: `Silkscreen aperture ${ap.id} is ${w.toFixed(3)} mm, below ${rules.minSilkWidthMm} mm.`,
        layer,
      });
    } else if (h + 1e-9 < rules.minSilkTextMm && ap.kind !== "C") {
      out.push({
        id: `silk-text-${layer}-${ap.id}`,
        check: "silk",
        severity: "warn",
        message: `Silkscreen feature ${ap.id} is ${h.toFixed(3)} mm tall; ${rules.minSilkTextMm} mm is typical for readable text.`,
        layer,
      });
    }
  }
  return out;
}

function silkOverMask(
  silk: ParsedGerber,
  maskFile: ClassifiedFile,
  layer: string,
): FabCheckFinding[] {
  let mask: ParsedGerber;
  try {
    mask = parseGerber(maskFile.body);
  } catch {
    return [];
  }
  const bounds = gerberBounds(silk, 0.4);
  const silkR = rasterizeGerber(silk, { bounds, scale: 40, maxPx: 900 });
  const maskR = rasterizeGerber(mask, { bounds, scale: silkR.scale, maxPx: 900 });
  const out: FabCheckFinding[] = [];
  for (let y = 0; y < silkR.height; y++) {
    for (let x = 0; x < silkR.width; x++) {
      if (!silkR.data[y * silkR.width + x] || !maskR.data[y * maskR.width + x]) continue;
      const pt = fromPixel(silkR, x, y);
      out.push({
        id: `silk-pad-${layer}-${out.length}`,
        check: "silk",
        severity: "fail",
        message: `Silkscreen overlaps a soldermask opening on ${layer}.`,
        x: round4(pt.x),
        y: round4(pt.y),
        layer,
      });
      if (out.length >= 12) return out;
      // Skip nearby pixels so we report distinct locations.
      x += 4;
    }
  }
  return out;
}

function silkOutside(silk: ParsedGerber, poly: Point[], layer: string): FabCheckFinding[] {
  const out: FabCheckFinding[] = [];
  const check = (x: number, y: number) => {
    if (pointInPolygon({ x, y }, poly)) return;
    out.push({
      id: `silk-outside-${layer}-${out.length}`,
      check: "silk",
      severity: "fail",
      message: `Silkscreen artwork is outside the board outline on ${layer}.`,
      x: round4(x),
      y: round4(y),
      layer,
    });
  };
  for (const op of silk.ops) {
    if (out.length >= 12) break;
    if (op.op === "flash") check(op.x, op.y);
    else if (op.op === "draw") {
      check(op.x1, op.y1);
      check(op.x2, op.y2);
    } else if (op.points[0]) check(op.points[0].x, op.points[0].y);
  }
  return out;
}

function outlinePolygon(file: ClassifiedFile): Point[] {
  try {
    const parsed = parseGerber(file.body);
    const segs = parsed.ops
      .filter((op): op is Extract<typeof op, { op: "draw" }> => op.op === "draw")
      .map((op) => ({ x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 }));
    const contours = chainContours(segs);
    const closed = contours.find((c) => c.closed) ?? contours[0];
    return closed?.points ?? [];
  } catch {
    return [];
  }
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
