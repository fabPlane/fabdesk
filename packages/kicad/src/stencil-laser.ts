/**
 * Laser-cut solder-stencil export: layered SVG/DXF plus a LightBurn .lbrn2 job
 * for a ComMarker Omni X 355 nm UV galvo (LightBurn / EZCAD). Reuses the 2D
 * paste layout from stencil.ts (no mesh).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import polygonClipping from "polygon-clipping";
import {
  buildStencilLayout,
  type StencilAlignmentHole,
  type StencilAperture,
  type StencilBounds,
  type StencilLayout,
  type StencilOptions,
  type StencilSide,
  type StencilWarning,
  type Vec2,
} from "./stencil";
import { laserStencilLbrn2 } from "./stencil-laser-lbrn2";

export const LASER_STENCIL_PRESET_IDS = ["mylar-uv", "kapton", "stainless-0.1"] as const;
export type LaserStencilPresetId = (typeof LASER_STENCIL_PRESET_IDS)[number];

/** User-facing option error. The export tool wraps this as ToolError `invalid_args`. */
export class LaserStencilOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaserStencilOptionsError";
  }
}

/** Starting-point galvo settings. Always labeled as starting points in UI and notes. */
export type LaserJobSettings = {
  powerPct: number;
  speedMmPerS: number;
  frequencyKhz: number;
  pulseNs: number;
  passes: number;
  lensMm: number;
};

export type LaserStencilPreset = {
  id: LaserStencilPresetId;
  title: string;
  material: string;
  materialFamily: "mylar" | "kapton" | "stainless";
  machine: string;
  software: string[];
  thicknessMm: number;
  frameMm: number;
  /** Positive shrinks each pad aperture inward, per side (paste release). */
  apertureOffsetMm: number;
  /** Extra inward offset per side for laser kerf. Applied on top of apertureOffsetMm. */
  kerfMm: number;
  minApertureMm: number;
  skipFinePitch: boolean;
  finePitchMm: number;
  alignmentHoleMm: number;
  includeFiducials: boolean;
  job: LaserJobSettings;
};

export const LASER_STENCIL_PRESETS: Record<LaserStencilPresetId, LaserStencilPreset> = {
  "mylar-uv": {
    id: "mylar-uv",
    title: "0.1 mm Mylar (PET) · Omni X 355 nm UV",
    material: "0.1 mm Mylar / polyester (PET) film",
    materialFamily: "mylar",
    machine: "ComMarker Omni X (355 nm UV galvo, ~5 W; 6 W / 12 W variants exist)",
    software: ["LightBurn", "EZCAD", "ComMarker Studio"],
    thicknessMm: 0.1,
    frameMm: 8,
    apertureOffsetMm: 0.05,
    kerfMm: 0.015,
    minApertureMm: 0.15,
    skipFinePitch: false,
    finePitchMm: 0.5,
    alignmentHoleMm: 3.2,
    includeFiducials: true,
    job: {
      powerPct: 100,
      speedMmPerS: 1200,
      frequencyKhz: 30,
      pulseNs: 1,
      passes: 2,
      lensMm: 150,
    },
  },
  kapton: {
    id: "kapton",
    title: "0.075 mm Kapton (PI)",
    material: "0.075 mm Kapton / polyimide (PI) film",
    materialFamily: "kapton",
    machine: "ComMarker Omni X (355 nm UV galvo, ~5 W; 6 W / 12 W variants exist)",
    software: ["LightBurn", "EZCAD", "ComMarker Studio"],
    thicknessMm: 0.075,
    frameMm: 8,
    apertureOffsetMm: 0.04,
    kerfMm: 0.015,
    minApertureMm: 0.15,
    skipFinePitch: false,
    finePitchMm: 0.5,
    alignmentHoleMm: 3.2,
    includeFiducials: true,
    job: {
      powerPct: 100,
      speedMmPerS: 1600,
      frequencyKhz: 30,
      pulseNs: 1,
      passes: 2,
      lensMm: 150,
    },
  },
  "stainless-0.1": {
    id: "stainless-0.1",
    title: "0.1 mm stainless-steel stencil foil",
    material: "0.1 mm stainless-steel stencil foil",
    materialFamily: "stainless",
    machine: "ComMarker Omni X (355 nm UV) or an equivalent fiber/UV galvo",
    software: ["LightBurn", "EZCAD", "ComMarker Studio"],
    thicknessMm: 0.1,
    frameMm: 8,
    apertureOffsetMm: 0.05,
    kerfMm: 0.02,
    minApertureMm: 0.25,
    skipFinePitch: false,
    finePitchMm: 0.5,
    alignmentHoleMm: 3.2,
    includeFiducials: true,
    job: {
      powerPct: 100,
      speedMmPerS: 20,
      frequencyKhz: 40,
      pulseNs: 1,
      passes: 8,
      lensMm: 150,
    },
  },
};

export type LaserStencilOptions = {
  side?: StencilSide;
  preset?: LaserStencilPresetId;
  frameMm?: number;
  thicknessMm?: number;
  apertureOffsetMm?: number;
  kerfMm?: number;
  minApertureMm?: number;
  skipFinePitch?: boolean;
  finePitchMm?: number;
  alignmentHoleMm?: number;
  includeFiducials?: boolean;
  powerPct?: number;
  speedMmPerS?: number;
  frequencyKhz?: number;
  pulseNs?: number;
  passes?: number;
  lensMm?: number;
};

export type LaserStencilExportOptions = LaserStencilOptions & {
  board: string;
  outDir: string;
};

export type LaserCutPath = {
  layer: "APERTURES" | "FRAME" | "FIDUCIALS" | "GUIDE";
  kind: "polygon" | "circle";
  points?: Vec2[];
  x?: number;
  y?: number;
  radiusMm?: number;
};

export type LaserStencilBuild = {
  preset: LaserStencilPreset;
  layout: StencilLayout;
  apertures: StencilAperture[];
  skipped: StencilLayout["skipped"];
  frame: StencilBounds;
  board: StencilBounds;
  fiducials: StencilAlignmentHole[];
  warnings: StencilWarning[];
  paths: LaserCutPath[];
  job: LaserJobSettings;
  kerfMm: number;
  apertureOffsetMm: number;
  options: Required<Pick<LaserStencilOptions, "side" | "includeFiducials">> & {
    preset: LaserStencilPresetId;
    frameMm: number;
    thicknessMm: number;
    apertureOffsetMm: number;
    kerfMm: number;
    minApertureMm: number;
    skipFinePitch: boolean;
    finePitchMm: number;
    alignmentHoleMm: number;
  };
};

export type LaserStencilSummary = {
  side: StencilSide;
  preset: LaserStencilPresetId;
  presetTitle: string;
  material: string;
  padCount: number;
  apertureCount: number;
  skippedCount: number;
  fiducialCount: number;
  minApertureMm: number | null;
  apertureOffsetMm: number;
  kerfMm: number;
  totalShrinkMm: number;
  thicknessMm: number;
  frameMm: number;
  job: LaserJobSettings;
  board: StencilBounds;
  plate: StencilBounds;
  fiducials: StencilAlignmentHole[];
  warnings: StencilWarning[];
  files: {
    lbrn2: string;
    svg: string;
    dxf: string;
    json: string;
    markdown: string;
    notes: string;
  };
};

const LAYER_COLORS = {
  APERTURES: "#FF0000",
  FRAME: "#000000",
  FIDUCIALS: "#0000FF",
  GUIDE: "#00CCCC",
} as const;

function finiteNumber(name: string, value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value)) throw new LaserStencilOptionsError(`${name} must be finite`);
  return value;
}

function positiveNumber(name: string, value: number): number {
  if (!(value > 0)) throw new LaserStencilOptionsError(`${name} must be > 0`);
  return value;
}

export function resolveLaserJobSettings(
  preset: LaserStencilPreset,
  opts: LaserStencilOptions = {},
): LaserJobSettings {
  return {
    powerPct: finiteNumber("powerPct", opts.powerPct, preset.job.powerPct),
    speedMmPerS: positiveNumber(
      "speedMmPerS",
      finiteNumber("speedMmPerS", opts.speedMmPerS, preset.job.speedMmPerS),
    ),
    frequencyKhz: positiveNumber(
      "frequencyKhz",
      finiteNumber("frequencyKhz", opts.frequencyKhz, preset.job.frequencyKhz),
    ),
    pulseNs: positiveNumber("pulseNs", finiteNumber("pulseNs", opts.pulseNs, preset.job.pulseNs)),
    passes: Math.max(
      1,
      Math.round(positiveNumber("passes", finiteNumber("passes", opts.passes, preset.job.passes))),
    ),
    lensMm: positiveNumber("lensMm", finiteNumber("lensMm", opts.lensMm, preset.job.lensMm)),
  };
}

export function resolveLaserStencilOptions(opts: LaserStencilOptions = {}): {
  preset: LaserStencilPreset;
  layout: StencilOptions;
  side: StencilSide;
  job: LaserJobSettings;
  kerfMm: number;
  apertureOffsetMm: number;
  includeFiducials: boolean;
} {
  const preset = LASER_STENCIL_PRESETS[opts.preset ?? "mylar-uv"];
  if (!preset) throw new LaserStencilOptionsError(`unknown laser stencil preset: ${String(opts.preset)}`);
  const frameMm = finiteNumber("frameMm", opts.frameMm, preset.frameMm);
  const alignmentHoleMm = finiteNumber("alignmentHoleMm", opts.alignmentHoleMm, preset.alignmentHoleMm);
  const includeFiducials = opts.includeFiducials ?? preset.includeFiducials;
  if (includeFiducials && alignmentHoleMm + 0.4 > frameMm) {
    throw new LaserStencilOptionsError(
      `alignmentHoleMm ${alignmentHoleMm} does not fit in frameMm ${frameMm} (need frame >= hole + 0.4 mm clearance)`,
    );
  }
  const apertureOffsetMm = finiteNumber("apertureOffsetMm", opts.apertureOffsetMm, preset.apertureOffsetMm);
  const kerfMm = finiteNumber("kerfMm", opts.kerfMm, preset.kerfMm);
  const thicknessMm = positiveNumber(
    "thicknessMm",
    finiteNumber("thicknessMm", opts.thicknessMm, preset.thicknessMm),
  );
  const job = resolveLaserJobSettings(preset, opts);
  return {
    preset,
    side: opts.side ?? "F",
    job,
    kerfMm,
    apertureOffsetMm,
    includeFiducials,
    layout: {
      side: opts.side ?? "F",
      thicknessMm,
      frameMm,
      apertureOffsetMm: apertureOffsetMm + kerfMm,
      minApertureMm: finiteNumber("minApertureMm", opts.minApertureMm, preset.minApertureMm),
      skipFinePitch: opts.skipFinePitch ?? preset.skipFinePitch,
      finePitchMm: finiteNumber("finePitchMm", opts.finePitchMm, preset.finePitchMm),
      alignment: includeFiducials ? "holes" : "none",
      alignmentHoleMm,
      includeJig: false,
    },
  };
}

function holeOnBoard(hole: StencilAlignmentHole, board: StencilBounds): boolean {
  return hole.x >= board.minX && hole.x <= board.maxX && hole.y >= board.minY && hole.y <= board.maxY;
}

function closeRing(ring: Vec2[]): Vec2[] {
  const first = ring[0];
  const last = ring.at(-1);
  if (!first || !last) return ring;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function openRing(ring: Vec2[]): Vec2[] {
  const first = ring[0];
  const last = ring.at(-1);
  if (first && last && first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

/** Union stacked/overlapping paste records into the physical openings the laser should cut. */
export function unionAperturePolygons(apertures: StencilAperture[]): Vec2[][] {
  const polys = apertures
    .map((a) => a.polygon)
    .filter((ring) => ring.length >= 3)
    .map((ring) => [closeRing(ring)]);
  if (!polys.length) return [];
  const first = polys[0]!;
  const unioned = polys.length === 1 ? polygonClipping.union(first) : polygonClipping.union(first, ...polys.slice(1));
  const out: Vec2[][] = [];
  for (const poly of unioned) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const ring = openRing(outer.map(([x, y]) => [x, y] as Vec2));
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/** Four printer-frame registration holes in the stencil margin, plus board NPTH if present. */
export function laserFiducials(
  plate: StencilBounds,
  board: StencilBounds,
  npth: StencilAlignmentHole[],
  diameterMm: number,
): StencilAlignmentHole[] {
  const clearance = 0.2;
  const r = diameterMm / 2;
  const minMargin = r + clearance;
  const frameX = (plate.widthMm - board.widthMm) / 2;
  const frameY = (plate.heightMm - board.heightMm) / 2;
  if (frameX < 2 * minMargin || frameY < 2 * minMargin) return uniqueHoles(npth);
  const margin = Math.min(
    Math.max(minMargin, Math.min(frameX, frameY) * 0.45),
    Math.min(frameX, frameY) - minMargin,
  );
  const d = diameterMm;
  const corners: StencilAlignmentHole[] = [
    { x: plate.minX + margin, y: plate.minY + margin, diameterMm: d },
    { x: plate.maxX - margin, y: plate.minY + margin, diameterMm: d },
    { x: plate.maxX - margin, y: plate.maxY - margin, diameterMm: d },
    { x: plate.minX + margin, y: plate.maxY - margin, diameterMm: d },
  ].filter((h) => {
    const insidePlate =
      h.x - r >= plate.minX + clearance &&
      h.x + r <= plate.maxX - clearance &&
      h.y - r >= plate.minY + clearance &&
      h.y + r <= plate.maxY - clearance;
    const outsideBoard =
      h.x + r + clearance < board.minX ||
      h.x - r - clearance > board.maxX ||
      h.y + r + clearance < board.minY ||
      h.y - r - clearance > board.maxY;
    return insidePlate && outsideBoard;
  });
  return uniqueHoles([...npth, ...corners]);
}

function uniqueHoles(holes: StencilAlignmentHole[]): StencilAlignmentHole[] {
  const out: StencilAlignmentHole[] = [];
  for (const h of holes) {
    if (out.some((e) => Math.hypot(e.x - h.x, e.y - h.y) < 0.3)) continue;
    out.push(h);
  }
  return out;
}

export function buildLaserStencil(pcbText: string, opts: LaserStencilOptions = {}): LaserStencilBuild {
  const resolved = resolveLaserStencilOptions(opts);
  const layout = buildStencilLayout(pcbText, resolved.layout);
  const fiducials = resolved.includeFiducials
    ? laserFiducials(
        layout.plate,
        layout.board,
        layout.alignmentHoles.filter((h) => holeOnBoard(h, layout.board)),
        layout.options.alignmentHoleMm,
      )
    : [];
  if (layout.options.side === "B") {
    layout.warnings.push({
      code: "bottom_view",
      message:
        "Bottom stencil is as seen from above (KiCad coordinates). Mirror it in LightBurn or EZCAD if you apply the film against the board's back.",
    });
  }
  const paths: LaserCutPath[] = [
    {
      layer: "FRAME",
      kind: "polygon",
      points: [
        [layout.plate.minX, layout.plate.minY],
        [layout.plate.maxX, layout.plate.minY],
        [layout.plate.maxX, layout.plate.maxY],
        [layout.plate.minX, layout.plate.maxY],
      ],
    },
    {
      layer: "GUIDE",
      kind: "polygon",
      points: [
        [layout.board.minX, layout.board.minY],
        [layout.board.maxX, layout.board.minY],
        [layout.board.maxX, layout.board.maxY],
        [layout.board.minX, layout.board.maxY],
      ],
    },
    ...unionAperturePolygons(layout.apertures).map(
      (points): LaserCutPath => ({ layer: "APERTURES", kind: "polygon", points }),
    ),
    ...fiducials.map(
      (h): LaserCutPath => ({
        layer: "FIDUCIALS",
        kind: "circle",
        x: h.x,
        y: h.y,
        radiusMm: h.diameterMm / 2,
      }),
    ),
  ];
  return {
    preset: resolved.preset,
    layout,
    apertures: layout.apertures,
    skipped: layout.skipped,
    frame: layout.plate,
    board: layout.board,
    fiducials,
    warnings: layout.warnings,
    paths,
    job: resolved.job,
    kerfMm: resolved.kerfMm,
    apertureOffsetMm: resolved.apertureOffsetMm,
    options: {
      side: resolved.side,
      preset: resolved.preset.id,
      frameMm: layout.options.frameMm,
      thicknessMm: layout.options.thicknessMm,
      apertureOffsetMm: resolved.apertureOffsetMm,
      kerfMm: resolved.kerfMm,
      minApertureMm: layout.options.minApertureMm,
      skipFinePitch: layout.options.skipFinePitch,
      finePitchMm: layout.options.finePitchMm,
      alignmentHoleMm: layout.options.alignmentHoleMm,
      includeFiducials: resolved.includeFiducials,
    },
  };
}

export async function exportLaserStencil(opts: LaserStencilExportOptions): Promise<LaserStencilSummary> {
  const pcbText = await Bun.file(opts.board).text();
  const built = buildLaserStencil(pcbText, opts);
  await mkdir(opts.outDir, { recursive: true });
  const stem = `${built.layout.side}-Paste-laser`;
  const lbrn2 = join(opts.outDir, `${stem}.lbrn2`);
  const svg = join(opts.outDir, `${stem}.svg`);
  const dxf = join(opts.outDir, `${stem}.dxf`);
  const json = join(opts.outDir, `${stem}.json`);
  const markdown = join(opts.outDir, `${stem}.md`);
  const notes = join(opts.outDir, `${stem}-notes.md`);
  const summary = toSummary(built, { lbrn2, svg, dxf, json, markdown, notes });
  await writeFile(lbrn2, laserStencilLbrn2(built));
  await writeFile(svg, laserStencilSvg(built));
  await writeFile(dxf, laserStencilDxf(built));
  await writeFile(json, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(markdown, laserStencilMarkdown(summary));
  await writeFile(notes, laserStencilNotes(built));
  return summary;
}

function toSummary(built: LaserStencilBuild, files: LaserStencilSummary["files"]): LaserStencilSummary {
  const sizes = built.apertures.map((a) => Math.min(a.width, a.height));
  return {
    side: built.layout.side,
    preset: built.preset.id,
    presetTitle: built.preset.title,
    material: built.preset.material,
    padCount: built.layout.pads.length,
    apertureCount: built.apertures.length,
    skippedCount: built.skipped.length,
    fiducialCount: built.fiducials.length,
    minApertureMm: sizes.length ? Math.min(...sizes) : null,
    apertureOffsetMm: built.apertureOffsetMm,
    kerfMm: built.kerfMm,
    totalShrinkMm: built.apertureOffsetMm + built.kerfMm,
    thicknessMm: built.layout.options.thicknessMm,
    frameMm: built.layout.options.frameMm,
    job: built.job,
    board: built.board,
    plate: built.frame,
    fiducials: built.fiducials,
    warnings: built.warnings,
    files,
  };
}

export function laserStencilMarkdown(s: LaserStencilSummary): string {
  const warn = s.warnings.length ? s.warnings.map((w) => `- ${w.message}`).join("\n") : "- none";
  const min = s.minApertureMm == null ? "n/a" : `${s.minApertureMm.toFixed(3)} mm`;
  return `# Laser-cut solder stencil (${s.side}.Paste)

| | |
| --- | --- |
| Preset | ${s.presetTitle} |
| Material | ${s.material} |
| Paste records | ${s.padCount} |
| Apertures cut | ${s.apertureCount} |
| Skipped | ${s.skippedCount} |
| Fiducials | ${s.fiducialCount} |
| Paste-release shrink | ${s.apertureOffsetMm} mm per side |
| Kerf compensation | ${s.kerfMm} mm per side |
| Combined inward offset | ${s.totalShrinkMm} mm per side |
| Min aperture | ${min} |
| Thickness | ${s.thicknessMm} mm |
| Frame | ${s.frameMm} mm |
| Starting-point job | ${s.job.powerPct}% · ${s.job.speedMmPerS} mm/s · ${s.job.frequencyKhz} kHz · ${s.job.pulseNs} ns · ${s.job.passes} pass(es) · ${s.job.lensMm} mm lens |
| Board | ${s.board.widthMm.toFixed(2)} × ${s.board.heightMm.toFixed(2)} mm |
| Plate | ${s.plate.widthMm.toFixed(2)} × ${s.plate.heightMm.toFixed(2)} mm |

Open \`${basename(s.files.lbrn2)}\` in LightBurn for a one-click job (layers and starting-point cut settings already assigned). Import \`${basename(s.files.svg)}\` or \`${basename(s.files.dxf)}\` into EZCAD or ComMarker Studio. Units are millimetres. Assign colours / DXF layers: red = apertures, black = frame, blue = fiducials. Leave the cyan board outline as a guide (do not cut). Read \`${basename(s.files.notes)}\` for starting-point laser settings.

## Warnings
${warn}
`;
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

const SVG_STROKE = 0.02;

export function laserStencilSvg(built: LaserStencilBuild): string {
  const { frame, paths } = built;
  const w = frame.widthMm;
  const h = frame.heightMm;
  const tx = (x: number) => x - frame.minX;
  const ty = (y: number) => y - frame.minY;
  const fmt = (n: number) => n.toFixed(4);
  const groups: Record<LaserCutPath["layer"], string[]> = {
    APERTURES: [],
    FRAME: [],
    FIDUCIALS: [],
    GUIDE: [],
  };
  for (const path of paths) {
    if (path.kind === "circle" && path.x != null && path.y != null && path.radiusMm != null) {
      groups[path.layer].push(
        `<circle cx="${fmt(tx(path.x))}" cy="${fmt(ty(path.y))}" r="${fmt(path.radiusMm)}"/>`,
      );
      continue;
    }
    const pts = path.points;
    if (!pts || pts.length < 2) continue;
    groups[path.layer].push(
      `<polygon points="${pts.map(([x, y]) => `${fmt(tx(x))},${fmt(ty(y))}`).join(" ")}"/>`,
    );
  }
  const layer = (name: LaserCutPath["layer"], dash = false) => {
    const extra = dash ? ` stroke-dasharray="0.6 0.35"` : "";
    return `  <g id="${name}" fill="none" stroke="${LAYER_COLORS[name]}" stroke-width="${SVG_STROKE}"${extra}>
    ${groups[name].join("\n    ")}
  </g>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}" data-units="mm">
  <title>${escapeXml(built.preset.title)} · ${built.layout.side}.Paste</title>
  <desc>Cut-ready paste stencil for LightBurn / EZCAD. Red=apertures, black=frame, blue=fiducials, cyan=board guide (do not cut). Units: mm. Starting-point job: ${built.job.powerPct}% ${built.job.speedMmPerS}mm/s ${built.job.frequencyKhz}kHz ${built.job.passes} pass(es).</desc>
${layer("FRAME")}
${layer("GUIDE", true)}
${layer("APERTURES")}
${layer("FIDUCIALS")}
</svg>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** R12 ASCII DXF in millimetres. Y is flipped so the drawing matches the SVG in Y-up CAD. */
export function laserStencilDxf(built: LaserStencilBuild): string {
  const { frame, paths } = built;
  const tx = (x: number) => x - frame.minX;
  const ty = (y: number) => frame.maxY - y;
  const ents: string[] = [];
  for (const path of paths) {
    if (path.kind === "circle" && path.x != null && path.y != null && path.radiusMm != null) {
      ents.push(...dxfCircle(path.layer, tx(path.x), ty(path.y), path.radiusMm));
      continue;
    }
    const pts = path.points;
    if (!pts || pts.length < 2) continue;
    ents.push(...dxfPolyline(path.layer, pts.map(([x, y]) => [tx(x), ty(y)])));
  }
  return [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$ACADVER",
    "1",
    "AC1009",
    "9",
    "$INSUNITS",
    "70",
    "4",
    "9",
    "$MEASUREMENT",
    "70",
    "1",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "TABLES",
    "0",
    "TABLE",
    "2",
    "LTYPE",
    "70",
    "1",
    "0",
    "LTYPE",
    "2",
    "CONTINUOUS",
    "70",
    "0",
    "3",
    "Solid line",
    "72",
    "65",
    "73",
    "0",
    "40",
    "0.0",
    "0",
    "ENDTAB",
    "0",
    "TABLE",
    "2",
    "LAYER",
    "70",
    "4",
    ...dxfLayer("APERTURES", 1),
    ...dxfLayer("FRAME", 7),
    ...dxfLayer("FIDUCIALS", 5),
    ...dxfLayer("GUIDE", 4),
    "0",
    "ENDTAB",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
    ...ents,
    "0",
    "ENDSEC",
    "0",
    "EOF",
    "",
  ].join("\n");
}

function dxfLayer(name: string, color: number): string[] {
  return ["0", "LAYER", "2", name, "70", "0", "62", String(color), "6", "CONTINUOUS"];
}

function dxfPolyline(layer: string, pts: Vec2[]): string[] {
  const last = pts.at(-1);
  const first = pts[0];
  const closed =
    pts.length >= 2 && last !== undefined && first !== undefined && last[0] === first[0] && last[1] === first[1];
  const verts = closed ? pts.slice(0, -1) : pts;
  const out = ["0", "POLYLINE", "8", layer, "66", "1", "70", "1"];
  for (const [x, y] of verts) {
    out.push("0", "VERTEX", "8", layer, "10", x.toFixed(5), "20", y.toFixed(5), "30", "0");
  }
  out.push("0", "SEQEND");
  return out;
}

function dxfCircle(layer: string, x: number, y: number, r: number): string[] {
  return [
    "0",
    "CIRCLE",
    "8",
    layer,
    "10",
    x.toFixed(5),
    "20",
    y.toFixed(5),
    "30",
    "0",
    "40",
    r.toFixed(5),
  ];
}

export function laserStencilNotes(built: LaserStencilBuild): string {
  const p = built.preset;
  const j = built.job;
  return `# Starting-point laser settings — ${p.title}

**These numbers are starting points, not certified recipes.** Focus, lens, power variant
(5 W / 6 W / 12 W), film batch and fixture all change the cut. Run a coupon on scrap of
the same sheet, then adjust. Wear UV eyewear and ventilate; PET/Mylar, Kapton and
stainless fume are not something to breathe.

## Job

| | |
| --- | --- |
| Machine | ${p.machine} |
| Software | ${p.software.join(" / ")} |
| Material | ${p.material} |
| Geometry | ${built.layout.side}.Paste · ${built.apertures.length} aperture(s) · ${built.fiducials.length} fiducial(s) |
| Paste-release shrink | ${built.apertureOffsetMm} mm per side |
| Kerf compensation | ${built.kerfMm} mm per side (baked into the geometry) |
| Combined inward offset | ${built.apertureOffsetMm + built.kerfMm} mm per side |
| Min aperture | ${built.layout.options.minApertureMm} mm |
| Frame | ${built.layout.options.frameMm} mm around Edge.Cuts |
| Units | millimetres |

## Starting-point cut values (editable at export)

| | |
| --- | --- |
| Power | ${j.powerPct} % |
| Speed | ${j.speedMmPerS} mm/s |
| Frequency | ${j.frequencyKhz} kHz |
| Pulse width | ${j.pulseNs} ns |
| Passes | ${j.passes} |
| Lens | ${j.lensMm} mm |

The LightBurn \`.lbrn2\` job writes these onto the APERTURES, FRAME and FIDUCIALS layers.
Treat every cell as a **starting point**.

## Import

1. LightBurn (one-click): File → Open \`${built.layout.side}-Paste-laser.lbrn2\`. Devices →
   Create Manually → **BSLFiber**, laser type **UV**, Galvo 2 = X. Frequency range 20–200 kHz,
   pulse 1–50 ns. Calibrate the lens (9-point) before a real cut.
2. EZCAD / ComMarker Studio: File → Import the SVG (colour-mapped) or the DXF (layer-mapped).
   Both are mm. ComMarker Studio already loads Omni X lens data from the machine.
3. Map layers if you imported SVG/DXF instead of the \`.lbrn2\`:
   - \`APERTURES\` / red — through-cut
   - \`FRAME\` / black — through-cut sheet outline
   - \`FIDUCIALS\` / blue — through-cut registration holes (printer-frame pins + board NPTH)
   - \`GUIDE\` / cyan — board outline, **do not cut**
4. Disable Fill / hatch on every cut layer. Stencil openings are closed vector paths.
5. Bottom-side (\`B.Paste\`) artwork is still KiCad top-view. Mirror in the laser software
   if you will flip the film onto the back of the board.

${materialAdvice(p)}

## Aperture shrink and kerf

The export shrinks every paste pad by **paste-release offset + kerf** after KiCad paste
margin/ratio. Pads that fall below the preset minimum
(${built.layout.options.minApertureMm} mm) are skipped and listed in the markdown summary.
0.05 mm/side paste-release is a starting point, not a measured kerf. UV kerf on 0.1 mm
PET is usually ~0.01–0.03 mm; the preset adds that as a separate \`kerfMm\`. Measure a
cut coupon and raise/lower either value if openings print fat or starve.

## Fiducials

Printer-frame / jig pin holes (default Ø ${built.layout.options.alignmentHoleMm} mm) are placed in the extra frame when they fit; corners that would collide with the board outline are omitted.
Board NPTH tooling holes ≥ 1.5 mm are copied through so the film also registers to the PCB.
Turn fiducials off at export if you are cutting a sheet that will be taped without pins.

## Sources (public ComMarker support, starting points only)

- Parameters: https://support.commarker.com/hc/en-us/articles/49779932023449-Parameters-About-ComMarker-Omni-X
- Cutting appendix (PET/PI film, aluminium 0.5 mm): https://support.commarker.com/hc/en-us/articles/49717629130649-How-to-Perform-Cutting
- LightBurn Omni X setup: https://support.commarker.com/hc/en-us/articles/49950364833689-Omni-X-Correction-Guide-with-Lightburn
`;
}

function materialAdvice(p: LaserStencilPreset): string {
  if (p.materialFamily === "mylar") {
    return `## 0.1 mm clear Mylar / PET — ComMarker Omni X 355 nm UV

Official ComMarker Omni X 5 W tables list **PET/PI (PET Film)** (typically thinner than
0.1 mm stencil stock). The preset starts slower / adds a pass versus that published row
(1 pass / 2200 mm/s on a 150 mm lens). Power: start at **100 %** on a 5 W Omni X.
Transparent Mylar: focus on a scrap paper overlay first, then remove the paper.
If a pass does not free the aperture, add a pass or drop speed ~20 %. If the film melts
or browns, raise speed or lower power.`;
  }
  if (p.materialFamily === "kapton") {
    return `## 0.075 mm Kapton / PI — ComMarker Omni X 355 nm UV

Official Omni X tables list PET and PI together. Kapton (polyimide) is more
heat-tolerant than PET, so the preset starts a little faster than 0.1 mm Mylar.
0.05 mm / 0.075 mm / 0.125 mm Kapton stock all exist — match \`thicknessMm\` to the
sheet you have. If the film chars, raise speed; if openings do not drop out, add a
pass. Ventilate: polyimide cutting produces irritating fume.`;
  }
  return `## 0.1 mm stainless foil

There is no official Omni X row for 0.1 mm stainless stencil foil. These start from
ComMarker's **aluminium cutting 0.5 mm** row (12 passes / 5 mm/s on the 150 mm lens)
and assume thinner stock needs fewer / faster passes. A fiber galvo is usually the
better metal-foil cutter; keep the UV numbers only if that is the machine you have.
Clamp the foil flat on a sacrificial metal/ceramic plate. Do **not** treat this as a
substitute for a photo-etched fine-pitch metal stencil.`;
}
