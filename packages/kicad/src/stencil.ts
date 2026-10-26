/**
 * 3D-printed solder-stencil generation from a KiCad board's paste layer.
 * Pure TypeScript: kicadts for the board, polygon-clipping + earcut for the mesh.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import earcut, { flatten } from "earcut";
import { parseKicadPcb } from "kicadts";
import polygonClipping from "polygon-clipping";
import { stencilParseInput } from "./stencil-input";

export type StencilSide = "F" | "B";
export type StencilAlignment = "holes" | "pegs" | "none";

export type StencilOptions = {
  side?: StencilSide;
  thicknessMm?: number;
  frameMm?: number;
  /** Positive shrinks each pad aperture inward. */
  apertureOffsetMm?: number;
  minApertureMm?: number;
  skipFinePitch?: boolean;
  finePitchMm?: number;
  alignment?: StencilAlignment;
  alignmentHoleMm?: number;
  includeJig?: boolean;
  pcbThicknessMm?: number;
};

export type StencilExportOptions = StencilOptions & {
  board: string;
  outDir: string;
};

export type StencilWarning = {
  code: string;
  message: string;
  ref?: string;
  number?: string;
};

export type Vec2 = [number, number];
export type Ring = Vec2[];

export type StencilPadInfo = {
  /** Footprint identity, independent of possibly repeated reference labels. */
  footprintIndex: number;
  ref: string;
  number: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  shape: string;
  layers: string[];
  roundrectRatio: number;
  pasteMargin: number;
  pasteRatio: number;
};

export type StencilAperture = {
  ref: string;
  number: string;
  x: number;
  y: number;
  width: number;
  height: number;
  polygon: Ring;
};

export type StencilBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthMm: number;
  heightMm: number;
};

export type StencilAlignmentHole = { x: number; y: number; diameterMm: number };

export type StencilMesh = {
  /** 9 floats per triangle (v1, v2, v3). */
  positions: Float32Array;
  /** 3 floats per triangle. */
  normals: Float32Array;
};

export type StencilLayout = {
  side: StencilSide;
  pads: StencilPadInfo[];
  apertures: StencilAperture[];
  skipped: StencilPadInfo[];
  board: StencilBounds;
  plate: StencilBounds;
  alignmentHoles: StencilAlignmentHole[];
  warnings: StencilWarning[];
  options: Required<StencilOptions>;
};

export type StencilBuild = StencilLayout & {
  plateMesh: StencilMesh;
  jigMesh?: StencilMesh;
};

export type StencilSummary = {
  side: StencilSide;
  padCount: number;
  apertureCount: number;
  skippedCount: number;
  minApertureMm: number | null;
  thicknessMm: number;
  frameMm: number;
  board: StencilBounds;
  plate: StencilBounds;
  alignment: { kind: StencilAlignment; holes: StencilAlignmentHole[] };
  warnings: StencilWarning[];
  triangleCount: number;
  files: { stl: string; json: string; markdown: string; svg: string; jig?: string };
};

export const STENCIL_DEFAULTS = {
  side: "F" as StencilSide,
  thicknessMm: 0.15,
  frameMm: 5,
  apertureOffsetMm: 0,
  minApertureMm: 0,
  skipFinePitch: false,
  finePitchMm: 0.5,
  alignment: "none" as StencilAlignment,
  alignmentHoleMm: 3.2,
  includeJig: false,
  pcbThicknessMm: 1.6,
} satisfies Required<StencilOptions>;

const CIRCLE_SEGS = 24;
const STL_HEADER = "fabdesk solder stencil";

export function resolveStencilOptions(opts: StencilOptions = {}): Required<StencilOptions> {
  return {
    side: opts.side ?? STENCIL_DEFAULTS.side,
    thicknessMm: opts.thicknessMm ?? STENCIL_DEFAULTS.thicknessMm,
    frameMm: opts.frameMm ?? STENCIL_DEFAULTS.frameMm,
    apertureOffsetMm: opts.apertureOffsetMm ?? STENCIL_DEFAULTS.apertureOffsetMm,
    minApertureMm: opts.minApertureMm ?? STENCIL_DEFAULTS.minApertureMm,
    skipFinePitch: opts.skipFinePitch ?? STENCIL_DEFAULTS.skipFinePitch,
    finePitchMm: opts.finePitchMm ?? STENCIL_DEFAULTS.finePitchMm,
    alignment: opts.alignment ?? STENCIL_DEFAULTS.alignment,
    alignmentHoleMm: opts.alignmentHoleMm ?? STENCIL_DEFAULTS.alignmentHoleMm,
    includeJig: opts.includeJig ?? STENCIL_DEFAULTS.includeJig,
    pcbThicknessMm: opts.pcbThicknessMm ?? STENCIL_DEFAULTS.pcbThicknessMm,
  };
}

export function buildStencilLayout(pcbText: string, opts: StencilOptions = {}): StencilLayout {
  const options = resolveStencilOptions(opts);
  for (const key of [
    "thicknessMm",
    "frameMm",
    "apertureOffsetMm",
    "minApertureMm",
    "finePitchMm",
    "alignmentHoleMm",
    "pcbThicknessMm",
  ] as const) {
    if (!Number.isFinite(options[key])) throw new Error(`${key} must be finite`);
  }
  if (!(options.thicknessMm > 0)) throw new Error("thicknessMm must be > 0");
  if (options.frameMm < 0) throw new Error("frameMm must be >= 0");
  if (options.minApertureMm < 0) throw new Error("minApertureMm must be >= 0");
  if (options.finePitchMm <= 0 || options.alignmentHoleMm <= 0 || options.pcbThicknessMm <= 0) {
    throw new Error("finePitchMm, alignmentHoleMm and pcbThicknessMm must be > 0");
  }
  const pcb = parseKicadPcb(stencilParseInput(pcbText, options.side));
  assertSupportedPasteItems(pcb, options.side);
  const warnings: StencilWarning[] = [];
  const pads = [...collectPastePads(pcb, options.side), ...collectPasteRects(pcb, options.side)];
  if (pads.length === 0) {
    throw new Error(`no ${options.side}.Paste pads on the board`);
  }
  const board = boardOutline(pcb, pads, warnings, options.includeJig);
  const { apertures, skipped } = selectApertures(pads, options, warnings);
  const plate = expandBounds(board, options.frameMm);
  const alignmentHoles = alignmentHolesFor(pcb, plate, board, options, warnings);
  return {
    side: options.side,
    pads,
    apertures,
    skipped,
    board,
    plate,
    alignmentHoles,
    warnings,
    options,
  };
}

export function buildSolderStencil(pcbText: string, opts: StencilOptions = {}): StencilBuild {
  const layout = buildStencilLayout(pcbText, opts);
  const holePolys: Ring[] = [
    ...layout.apertures.map((a) => a.polygon),
    ...(layout.options.alignment === "none"
      ? []
      : layout.alignmentHoles.map((h) => circleRing(h.x, h.y, h.diameterMm / 2))),
  ];
  const plate2d = cutPlate(
    rectRing(layout.plate.minX, layout.plate.minY, layout.plate.maxX, layout.plate.maxY),
    holePolys,
  );
  const plateMesh = extrude(plate2d, 0, layout.options.thicknessMm);
  if (!checkMesh(plateMesh).watertight)
    throw new Error("Stencil mesh is not watertight; export native paste Gerbers instead.");
  let jigMesh: StencilMesh | undefined;
  if (layout.options.includeJig) {
    jigMesh = buildJigMesh(layout.plate, layout.board, layout.alignmentHoles, layout.options);
  }
  if (layout.options.side === "B") {
    layout.warnings.push({
      code: "bottom_view",
      message:
        "Bottom stencil is as seen from above (KiCad coordinates). Mirror it in the slicer if you print against the board's back.",
    });
  }
  return {
    ...layout,
    plateMesh,
    ...(jigMesh ? { jigMesh } : {}),
  };
}

export async function exportStencil(opts: StencilExportOptions): Promise<StencilSummary> {
  const pcbText = await Bun.file(opts.board).text();
  const built = buildSolderStencil(pcbText, opts);
  await mkdir(opts.outDir, { recursive: true });
  const stem = `${built.side}-Paste`;
  const stl = join(opts.outDir, `${stem}.stl`);
  const json = join(opts.outDir, `${stem}.json`);
  const markdown = join(opts.outDir, `${stem}.md`);
  const svg = join(opts.outDir, `${stem}.svg`);
  await writeFile(stl, encodeBinaryStl(built.plateMesh, `fabdesk ${stem} stencil`));
  const jigPath = built.jigMesh ? join(opts.outDir, `${stem}-jig.stl`) : undefined;
  if (built.jigMesh && jigPath)
    await writeFile(jigPath, encodeBinaryStl(built.jigMesh, `fabdesk ${stem} jig`));
  const summary = toSummary(built, {
    stl,
    json,
    markdown,
    svg,
    ...(jigPath ? { jig: jigPath } : {}),
  });
  await writeFile(json, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(markdown, stencilMarkdown(summary));
  await writeFile(svg, stencilPreviewSvg(built));
  return summary;
}

function toSummary(built: StencilBuild, files: StencilSummary["files"]): StencilSummary {
  const sizes = built.apertures.map((a) => Math.min(a.width, a.height));
  return {
    side: built.side,
    padCount: built.pads.length,
    apertureCount: apertureCount(built.apertures),
    skippedCount: built.skipped.length,
    minApertureMm: sizes.length ? Math.min(...sizes) : null,
    thicknessMm: built.options.thicknessMm,
    frameMm: built.options.frameMm,
    board: built.board,
    plate: built.plate,
    alignment: { kind: built.options.alignment, holes: built.alignmentHoles },
    warnings: built.warnings,
    triangleCount: built.plateMesh.positions.length / 9,
    files,
  };
}

export function stencilMarkdown(s: StencilSummary): string {
  const warn = s.warnings.length ? s.warnings.map((w) => `- ${w.message}`).join("\n") : "- none";
  const min = s.minApertureMm == null ? "n/a" : `${s.minApertureMm.toFixed(3)} mm`;
  return `# Solder stencil (${s.side}.Paste)

| | |
| --- | --- |
| Paste records (pads + filled rectangles) | ${s.padCount} |
| Apertures cut | ${s.apertureCount} |
| Skipped | ${s.skippedCount} |
| Min aperture | ${min} |
| Thickness | ${s.thicknessMm} mm |
| Frame | ${s.frameMm} mm |
| Board | ${s.board.widthMm.toFixed(2)} × ${s.board.heightMm.toFixed(2)} mm |
| Plate | ${s.plate.widthMm.toFixed(2)} × ${s.plate.heightMm.toFixed(2)} mm |
| Alignment | ${s.alignment.kind} (${s.alignment.holes.length} hole${s.alignment.holes.length === 1 ? "" : "s"}) |
| Triangles | ${s.triangleCount} |

## Warnings
${warn}

Paste geometry is preserved by default. Shrink, minimum-opening and fine-pitch filters are opt-in; inspect skipped-pad warnings if enabled.
Choose layers that sum to the requested thickness, and inspect the sliced openings. Geometry preservation does not guarantee that your nozzle can print every divider or that paste will release.
`;
}

export function stencilPreviewSvg(built: StencilBuild): string {
  const { plate, board, apertures, alignmentHoles, options } = built;
  const pad = 1;
  const w = plate.widthMm + pad * 2;
  const h = plate.heightMm + pad * 2;
  const tx = (x: number) => x - plate.minX + pad;
  const ty = (y: number) => y - plate.minY + pad;
  const ring = (pts: Ring, extra = "") =>
    `<polygon points="${pts.map(([x, y]) => `${tx(x).toFixed(3)},${ty(y).toFixed(3)}`).join(" ")}"${extra}/>`;
  const aperturesSvg = apertures
    .map((a) => ring(a.polygon, ` fill="#111" stroke="none"`))
    .join("\n");
  const holesSvg = alignmentHoles
    .map(
      (h) =>
        `<circle cx="${tx(h.x).toFixed(3)}" cy="${ty(h.y).toFixed(3)}" r="${(h.diameterMm / 2).toFixed(3)}" fill="#333"/>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}" width="${(w * 20).toFixed(0)}" height="${(h * 20).toFixed(0)}">
  <rect x="0" y="0" width="${w.toFixed(3)}" height="${h.toFixed(3)}" fill="#f4f1ea"/>
  ${ring(rectRing(plate.minX, plate.minY, plate.maxX, plate.maxY), ` fill="#c5cdd6" stroke="#4b5563" stroke-width="0.15"`)}
  ${ring(rectRing(board.minX, board.minY, board.maxX, board.maxY), ` fill="none" stroke="#2563eb" stroke-width="0.12" stroke-dasharray="0.6 0.35"`)}
  ${aperturesSvg}
  ${holesSvg}
  <text x="${pad}" y="${(h - 0.35).toFixed(3)}" font-size="0.9" font-family="ui-sans-serif,system-ui,sans-serif" fill="#374151">${built.side}.Paste stencil · ${options.thicknessMm} mm · ${apertureCount(apertures)} apertures</text>
</svg>
`;
}

/* ── board parse ─────────────────────────────────────────────────────────── */

type Pcb = ReturnType<typeof parseKicadPcb>;

function apertureCount(apertures: StencilAperture[]): number {
  const polys = apertures.map((a) => [closeRing(a.polygon)]);
  return polys.length ? polygonClipping.union(polys[0]!, ...polys.slice(1)).length : 0;
}

/** Do not silently export a partial stencil for features we cannot yet render. */
function assertSupportedPasteItems(pcb: Pcb, side: StencilSide): void {
  for (const parent of [pcb, ...pcb.footprints]) {
    for (const item of parent.getChildren()) {
      // Pads are handled below. Check every other layer-bearing item, including
      // footprint properties and dimensions, so unsupported paste text/artwork
      // cannot disappear silently just because it has a different token name.
      if (item.token === "pad") continue;
      const layer = item.getChildren().find((c) => c.token === "layer" || c.token === "layers");
      const names =
        layer && "names" in layer ? layer.names : layer && "layers" in layer ? layer.layers : [];
      if (Array.isArray(names) && layerHasPaste(names, side)) {
        if (item.token === "gr_rect" || item.token === "fp_rect") continue; // Validated by collectPasteRects.
        throw new Error(
          `Unsupported ${side}.Paste ${item.token}; export native paste Gerbers instead of a partial stencil.`,
        );
      }
    }
  }
}

function footprintPosition(fp: Pcb["footprints"][number]) {
  const scale = fp.transform?.scale;
  if (scale && (scale.x !== 1 || scale.y !== 1)) {
    throw new Error(
      "Stencil export does not yet support scaled footprint transforms; export native paste Gerbers instead.",
    );
  }
  return xyOf(fp.position);
}

/** Some connectors put paste openings in footprint graphics, separate from the
 * copper pads. KiCad paste margins do not resize these explicit rectangles. */
function collectPasteRects(pcb: Pcb, side: StencilSide): StencilPadInfo[] {
  const groups = [
    { rects: pcb.graphicRects, at: { x: 0, y: 0, angle: 0 }, ref: "board", footprintIndex: -1 },
    ...pcb.footprints.map((fp, footprintIndex) => ({
      rects: fp.fpRects,
      at: footprintPosition(fp),
      ref: fp.properties.find((p) => p.key === "Reference")?.value ?? "?",
      footprintIndex,
    })),
  ];
  const result: StencilPadInfo[] = [];
  for (const { rects, at, ref, footprintIndex } of groups) {
    for (const [index, rect] of rects.entries()) {
      const layers = rect.layer?.names ?? [];
      if (!layerHasPaste(layers, side)) continue;
      const fill =
        rect
          .getChildren()
          .find((c) => c.token === "fill")
          ?.getString() ?? "";
      if (!/\(fill (?:yes|solid)\)/.test(fill) || (rect.stroke?.width ?? rect.width ?? 0) !== 0) {
        throw new Error(
          `Unsupported ${side}.Paste ${rect.token}: only filled zero-stroke rectangles are supported; export native paste Gerbers instead.`,
        );
      }
      const a = rect.start,
        b = rect.end;
      if (!a || !b) throw new Error(`Missing coordinates on ${ref} paste rectangle`);
      const world = rotate((a.x + b.x) / 2, (a.y + b.y) / 2, at.angle);
      result.push({
        footprintIndex,
        ref,
        number: `graphic-${index + 1}`,
        x: at.x + world[0],
        y: at.y + world[1],
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
        angle: at.angle,
        shape: "rect",
        layers,
        roundrectRatio: 0,
        pasteMargin: 0,
        pasteRatio: 0,
      });
    }
  }
  return result;
}

function collectPastePads(pcb: Pcb, side: StencilSide): StencilPadInfo[] {
  const out: StencilPadInfo[] = [];
  for (const [footprintIndex, fp] of pcb.footprints.entries()) {
    const ref = fp.properties.find((p) => p.key === "Reference")?.value ?? "?";
    const fpAt = footprintPosition(fp);
    for (const pad of fp.fpPads) {
      const layers = pad.layers?.layers ?? [];
      if (!layerHasPaste(layers, side)) continue;
      const size = pad.size;
      if (!size) throw new Error(`Missing size on paste pad ${ref}.${pad.number}`);
      const padAt = xyOf(pad.at);
      // KiCad board coordinates have Y down. Saved bottom pads are already
      // flipped, and pad angles are absolute (including transform-format files).
      const world = rotate(padAt.x, padAt.y, fpAt.angle);
      if (!["rect", "roundrect", "circle", "oval"].includes(pad.shape) || pad.chamfer) {
        throw new Error(
          `Unsupported paste pad ${ref}.${pad.number}: ${pad.shape}/chamfer. Export native paste Gerbers instead.`,
        );
      }
      out.push({
        footprintIndex,
        ref,
        number: pad.number || "",
        x: fpAt.x + world[0],
        y: fpAt.y + world[1],
        width: size.width,
        height: size.height,
        angle: padAt.angle,
        shape: pad.shape || "rect",
        layers,
        roundrectRatio: pad.roundrectRatio ?? 0,
        // Margin and ratio resolve independently: pad -> footprint -> board.
        // An explicit zero is an override, not the same as an absent field.
        pasteMargin:
          pad.solderPasteMargin ??
          fp.solderPasteMargin?.value ??
          pcb.setup?.padToPasteClearance ??
          0,
        pasteRatio:
          pad.solderPasteMarginRatio ??
          fp.solderPasteRatio?.value ??
          pcb.setup?.padToPasteClearanceRatio ??
          0,
      });
    }
  }
  return out;
}

function layerHasPaste(layers: string[], side: StencilSide): boolean {
  const want = `${side}.Paste`;
  return layers.some((l) => l === want || l === "*.Paste" || l === "F&B.Paste");
}

const onEdgeCuts = (item: { layer?: { names?: string[] } | undefined }) =>
  (item.layer?.names ?? []).includes("Edge.Cuts");
const xy = (p: { x: number; y: number } | undefined): Vec2[] => (p ? [[p.x, p.y]] : []);

/** Points bounding a three-point arc: its ends plus every axis extreme the sweep passes. */
export function arcExtentPoints(start: Vec2, mid: Vec2, end: Vec2): Vec2[] {
  const [ax, ay] = start;
  const [bx, by] = mid;
  const [cx, cy] = end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [start, mid, end];
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ox, ay - oy);
  const TAU = Math.PI * 2;
  const ang = (x: number, y: number) => (Math.atan2(y - oy, x - ox) + TAU) % TAU;
  const a0 = ang(ax, ay);
  const ccw = (t: number) => (t - a0 + TAU) % TAU;
  const toMid = ccw(ang(bx, by));
  const toEnd = ccw(ang(cx, cy));
  const forward = toMid <= toEnd;
  const sweep = forward ? toEnd : TAU - toEnd;
  const pts: Vec2[] = [start, mid, end];
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2;
    const off = forward ? ccw(t) : (a0 - t + TAU) % TAU;
    if (off <= sweep) pts.push([ox + r * Math.cos(t), oy + r * Math.sin(t)]);
  }
  return pts;
}

/** Bounds of every Edge.Cuts primitive (rect, poly, line, arc, circle), or null when there are none. */
export function edgeCutsBounds(pcb: Pcb): StencilBounds | null {
  const pts: Vec2[] = [];
  for (const r of pcb.graphicRects.filter(onEdgeCuts))
    pts.push(...xy(r.startPoint), ...xy(r.endPoint));
  for (const poly of pcb.graphicPolys.filter(onEdgeCuts)) {
    for (const p of poly.points?.points ?? []) {
      if ("x" in p && "y" in p && typeof p.x === "number" && typeof p.y === "number")
        pts.push([p.x, p.y]);
    }
  }
  for (const l of pcb.graphicLines.filter(onEdgeCuts))
    pts.push(...xy(l.startPoint), ...xy(l.endPoint));
  for (const a of pcb.graphicArcs.filter(onEdgeCuts)) {
    const [s0, m0, e0] = [a.startPoint, a.midPoint, a.endPoint];
    if (s0 && m0 && e0) pts.push(...arcExtentPoints([s0.x, s0.y], [m0.x, m0.y], [e0.x, e0.y]));
    else pts.push(...xy(s0), ...xy(e0));
  }
  for (const c of pcb.graphicCircles.filter(onEdgeCuts)) {
    const [o, e] = [c.centerPoint, c.endPoint];
    if (!o || !e) continue;
    const r = Math.hypot(e.x - o.x, e.y - o.y);
    pts.push([o.x - r, o.y - r], [o.x + r, o.y + r]);
  }
  if (pts.length < 2) return null;
  const box = boundsOf(pts);
  return box.widthMm > 0 && box.heightMm > 0 ? box : null;
}

function boardOutline(
  pcb: Pcb,
  pads: StencilPadInfo[],
  warnings: StencilWarning[],
  includeJig: boolean,
): StencilBounds {
  const outline = edgeCutsBounds(pcb);
  if (outline) return outline;
  if (includeJig) {
    throw new Error(
      "no Edge.Cuts outline; a jig pocket needs the real board size (draw the outline or omit the jig)",
    );
  }
  warnings.push({
    code: "no_edge_cuts",
    message: "No Edge.Cuts outline; plate sized from paste-pad bounding box plus 1 mm.",
  });
  const box = boundsOf(pads.map((p) => [p.x, p.y] as Vec2));
  return expandBounds(box, 1);
}

function collectToolingHoles(pcb: Pcb): StencilAlignmentHole[] {
  const holes: StencilAlignmentHole[] = [];
  for (const fp of pcb.footprints) {
    const fpAt = footprintPosition(fp);
    for (const pad of fp.fpPads) {
      if (pad.padType !== "npth" && pad.padType !== "np_thru_hole") continue;
      const d = pad.drill?.diameter ?? pad.size?.width ?? 0;
      if (d < 1.5) continue;
      const padAt = xyOf(pad.at);
      const world = rotate(padAt.x, padAt.y, fpAt.angle);
      holes.push({ x: fpAt.x + world[0], y: fpAt.y + world[1], diameterMm: d });
    }
  }
  return holes;
}

function alignmentHolesFor(
  pcb: Pcb,
  plate: StencilBounds,
  board: StencilBounds,
  options: Required<StencilOptions>,
  warnings: StencilWarning[],
): StencilAlignmentHole[] {
  if (options.alignment === "none") return [];
  const tooling = collectToolingHoles(pcb);
  if (tooling.length >= 2) return tooling;
  if (tooling.length === 1) {
    warnings.push({
      code: "few_tooling_holes",
      message: "Only one NPTH tooling hole; adding frame-corner registration holes as well.",
    });
  } else {
    warnings.push({
      code: "no_tooling_holes",
      message:
        "No NPTH tooling holes ≥ 1.5 mm; placing registration holes in the stencil frame corners.",
    });
  }
  const inset = Math.min(options.frameMm * 0.45, 2.2);
  const d = options.alignmentHoleMm;
  const corners: StencilAlignmentHole[] = [
    { x: plate.minX + inset, y: plate.minY + inset, diameterMm: d },
    { x: plate.maxX - inset, y: plate.minY + inset, diameterMm: d },
    { x: plate.maxX - inset, y: plate.maxY - inset, diameterMm: d },
    { x: plate.minX + inset, y: plate.maxY - inset, diameterMm: d },
  ].filter(
    (h) =>
      h.x < board.minX - d / 2 ||
      h.x > board.maxX + d / 2 ||
      h.y < board.minY - d / 2 ||
      h.y > board.maxY + d / 2,
  );
  return [...tooling, ...corners];
}

function selectApertures(
  pads: StencilPadInfo[],
  options: Required<StencilOptions>,
  warnings: StencilWarning[],
): { apertures: StencilAperture[]; skipped: StencilPadInfo[] } {
  const fine = new Set<StencilPadInfo>();
  if (options.skipFinePitch) {
    const byRef = new Map<number, StencilPadInfo[]>();
    for (const p of pads) {
      const list = byRef.get(p.footprintIndex) ?? [];
      list.push(p);
      byRef.set(p.footprintIndex, list);
    }
    for (const group of byRef.values()) {
      if (group.length < 2) continue;
      let minPitch = Infinity;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          // Stacked pad records (e.g. USB-C) are one location, not zero pitch.
          if (distance > 1e-7) minPitch = Math.min(minPitch, distance);
        }
      }
      if (minPitch < options.finePitchMm - 1e-7) {
        for (const p of group) fine.add(p);
        const first = group[0]!;
        warnings.push({
          code: "fine_pitch",
          message: `Skipped ${group.length} pad(s) on ${first.ref}: pitch ${minPitch.toFixed(2)} mm is below ${options.finePitchMm} mm (FDM/resin stencil limit).`,
          ...(first.ref ? { ref: first.ref } : {}),
        });
      }
    }
  }
  const apertures: StencilAperture[] = [];
  const skipped: StencilPadInfo[] = [];
  for (const pad of pads) {
    if (fine.has(pad)) {
      skipped.push(pad);
      continue;
    }
    const w =
      pad.width * (1 + 2 * pad.pasteRatio) + 2 * pad.pasteMargin - 2 * options.apertureOffsetMm;
    const h =
      pad.height * (1 + 2 * pad.pasteRatio) + 2 * pad.pasteMargin - 2 * options.apertureOffsetMm;
    if (w < options.minApertureMm || h < options.minApertureMm || w <= 0 || h <= 0) {
      skipped.push(pad);
      warnings.push({
        code: "small_aperture",
        message: `Skipped ${pad.ref}.${pad.number || "?"} (${pad.width.toFixed(2)}×${pad.height.toFixed(2)} mm): after ${options.apertureOffsetMm} mm shrink the opening is below ${options.minApertureMm} mm.`,
        ...(pad.ref ? { ref: pad.ref } : {}),
        ...(pad.number ? { number: pad.number } : {}),
      });
      continue;
    }
    apertures.push({
      ref: pad.ref,
      number: pad.number,
      x: pad.x,
      y: pad.y,
      width: w,
      height: h,
      polygon: padPolygon(pad.x, pad.y, w, h, pad.angle, pad.shape, pad.roundrectRatio),
    });
  }
  return { apertures, skipped };
}

function padPolygon(
  x: number,
  y: number,
  w: number,
  h: number,
  angle: number,
  shape: string,
  ratio = 0,
): Ring {
  if (shape === "circle") return circleRing(x, y, Math.min(w, h) / 2);
  if (shape === "oval") return ovalRing(x, y, w, h, angle);
  if (shape === "roundrect") return roundedRectRing(x, y, w, h, Math.min(w, h) * ratio, angle);
  return rectRingCentered(x, y, w, h, angle);
}

/* ── 2D helpers ──────────────────────────────────────────────────────────── */

function xyOf(p: { x: number; y: number; angle?: number } | undefined): {
  x: number;
  y: number;
  angle: number;
} {
  if (!p) return { x: 0, y: 0, angle: 0 };
  return { x: p.x, y: p.y, angle: typeof p.angle === "number" ? p.angle : 0 };
}

function rotate(x: number, y: number, deg: number): Vec2 {
  const a = (-deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function boundsOf(pts: Vec2[]): StencilBounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, widthMm: maxX - minX, heightMm: maxY - minY };
}

function expandBounds(b: StencilBounds, m: number): StencilBounds {
  return {
    minX: b.minX - m,
    minY: b.minY - m,
    maxX: b.maxX + m,
    maxY: b.maxY + m,
    widthMm: b.widthMm + 2 * m,
    heightMm: b.heightMm + 2 * m,
  };
}

function closeRing(ring: Ring): Ring {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function ensureWinding(ring: Ring, ccw: boolean): Ring {
  const pos = ringArea(ring) > 0;
  return pos === ccw ? ring : [...ring].reverse();
}

function rectRing(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return ensureWinding(
    [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
    true,
  );
}

function rectRingCentered(x: number, y: number, w: number, h: number, angle: number): Ring {
  const hw = w / 2;
  const hh = h / 2;
  const pts: Ring = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map((p) => {
    const [rx, ry] = rotate(p[0] ?? 0, p[1] ?? 0, angle);
    return [x + rx, y + ry];
  });
  return ensureWinding(pts, true);
}

function circleRing(x: number, y: number, r: number, segs = CIRCLE_SEGS): Ring {
  const pts: Ring = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    pts.push([x + Math.cos(t) * r, y + Math.sin(t) * r]);
  }
  return ensureWinding(pts, true);
}

function ovalRing(
  x: number,
  y: number,
  w: number,
  h: number,
  angle: number,
  segs = CIRCLE_SEGS,
): Ring {
  return roundedRectRing(x, y, w, h, Math.min(w, h) / 2, angle, segs);
}

/** KiCad ovals are capsules, not ellipses. Roundrects share this construction. */
function roundedRectRing(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  angle: number,
  segs = CIRCLE_SEGS,
): Ring {
  const r = Math.min(Math.max(radius, 0), Math.min(w, h) / 2);
  if (r === 0) return rectRingCentered(x, y, w, h, angle);
  const pts: Ring = [];
  const corners: Vec2[] = [
    [w / 2 - r, h / 2 - r],
    [-w / 2 + r, h / 2 - r],
    [-w / 2 + r, -h / 2 + r],
    [w / 2 - r, -h / 2 + r],
  ];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i <= segs / 4; i++) {
      const t = ((c + i / (segs / 4)) * Math.PI) / 2;
      const [rx, ry] = rotate(
        corners[c]![0] + r * Math.cos(t),
        corners[c]![1] + r * Math.sin(t),
        angle,
      );
      const point: Vec2 = [x + rx, y + ry];
      const last = pts.at(-1);
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-9) pts.push(point);
    }
  }
  if (Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]) < 1e-9) pts.pop();
  return ensureWinding(pts, true);
}

function cutPlate(outer: Ring, holes: Ring[]): Ring[][] {
  const subject = [closeRing(ensureWinding(outer, true))];
  const clips = holes.filter((h) => h.length >= 3).map((h) => [closeRing(ensureWinding(h, true))]);
  const result =
    clips.length === 0
      ? polygonClipping.union(subject)
      : polygonClipping.difference(subject, ...clips);
  return result.map((poly) =>
    poly.map((ring, i) => ensureWinding(openRing(ring.map(([x, y]) => [x, y] as Vec2)), i === 0)),
  );
}

function openRing(ring: Ring): Ring {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

/* ── mesh ────────────────────────────────────────────────────────────────── */

type TriBuf = { pos: number[]; nrm: number[] };

function extrude(polygons: Ring[][], z0: number, z1: number): StencilMesh {
  const buf: TriBuf = { pos: [], nrm: [] };
  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const holes = poly.slice(1);
    addCap(buf, [outer, ...holes], z1, 1);
    addCap(buf, [outer, ...holes], z0, -1);
    for (const [i, ring] of poly.entries()) addWalls(buf, ring, z0, z1, i === 0);
  }
  return splitTJunctions(toMesh(buf));
}

function addCap(buf: TriBuf, rings: Ring[], z: number, sign: 1 | -1): void {
  const data = flatten(rings);
  const idx = earcut(data.vertices, data.holes, data.dimensions);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] ?? 0;
    const b = idx[i + 1] ?? 0;
    const c = idx[i + 2] ?? 0;
    const ax = data.vertices[a * 2] ?? 0;
    const ay = data.vertices[a * 2 + 1] ?? 0;
    const bx = data.vertices[b * 2] ?? 0;
    const by = data.vertices[b * 2 + 1] ?? 0;
    const cx = data.vertices[c * 2] ?? 0;
    const cy = data.vertices[c * 2 + 1] ?? 0;
    if (sign > 0) addTri(buf, [ax, ay, z], [bx, by, z], [cx, cy, z]);
    else addTri(buf, [ax, ay, z], [cx, cy, z], [bx, by, z]);
  }
}

function addWalls(buf: TriBuf, ring: Ring, z0: number, z1: number, outer: boolean): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    // Outer CCW: a→b has interior left; this winding faces outward.
    // Holes are CW so the same formula faces into the aperture.
    void outer;
    addTri(buf, [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1]);
    addTri(buf, [a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
  }
}

function addTri(
  buf: TriBuf,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): void {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  // Earcut / float32 conversion can leave a collinear cap triangle. It has no
  // surface area and creates duplicated edges if emitted into the STL.
  if (len < 1e-14) return;
  nx /= len;
  ny /= len;
  nz /= len;
  buf.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  buf.nrm.push(nx, ny, nz);
}

function toMesh(buf: TriBuf): StencilMesh {
  return { positions: new Float32Array(buf.pos), normals: new Float32Array(buf.nrm) };
}

/** Split cap edges that skip vertices on a collinear hole/wall edge (earcut T-junctions). */
function splitTJunctions(mesh: StencilMesh): StencilMesh {
  const verts: Array<[number, number, number]> = [];
  const count = mesh.positions.length / 9;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    verts.push(
      [mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0],
      [mesh.positions[i + 3] ?? 0, mesh.positions[i + 4] ?? 0, mesh.positions[i + 5] ?? 0],
      [mesh.positions[i + 6] ?? 0, mesh.positions[i + 7] ?? 0, mesh.positions[i + 8] ?? 0],
    );
  }
  const unique: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  const qk = (v: [number, number, number]) =>
    `${Math.round(v[0] * 1e6)},${Math.round(v[1] * 1e6)},${Math.round(v[2] * 1e6)}`;
  for (const v of verts) {
    const k = qk(v);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(v);
  }
  const buf: TriBuf = { pos: [], nrm: [] };
  const emit = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): void => {
    const ab = closestOn(a, b, unique);
    if (ab) {
      emit(a, ab, c);
      emit(ab, b, c);
      return;
    }
    const bc = closestOn(b, c, unique);
    if (bc) {
      emit(a, b, bc);
      emit(a, bc, c);
      return;
    }
    const ca = closestOn(c, a, unique);
    if (ca) {
      emit(a, b, ca);
      emit(b, c, ca);
      return;
    }
    addTri(buf, a, b, c);
  };
  for (let t = 0; t < count; t++) emit(verts[t * 3]!, verts[t * 3 + 1]!, verts[t * 3 + 2]!);
  return toMesh(buf);
}

function closestOn(
  a: [number, number, number],
  b: [number, number, number],
  pts: Array<[number, number, number]>,
): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let bestD = Infinity;
  for (const p of pts) {
    if (!onSegment(a, b, p)) continue;
    const d = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function onSegment(
  a: [number, number, number],
  b: [number, number, number],
  p: [number, number, number],
  eps = 1e-7,
): boolean {
  // Most vertices cannot lie on this edge. Reject them before expensive norms;
  // rounded pads on real boards otherwise make T-junction repair very slow.
  for (let axis = 0; axis < 3; axis++) {
    if (
      p[axis]! < Math.min(a[axis]!, b[axis]!) - eps ||
      p[axis]! > Math.max(a[axis]!, b[axis]!) + eps
    )
      return false;
  }
  if (samePt(a, p) || samePt(b, p)) return false;
  const abx = b[0] - a[0],
    aby = b[1] - a[1],
    abz = b[2] - a[2];
  const apx = p[0] - a[0],
    apy = p[1] - a[1],
    apz = p[2] - a[2];
  const ab2 = abx * abx + aby * aby + abz * abz;
  if (ab2 < eps * eps) return false;
  const cross = Math.hypot(aby * apz - abz * apy, abz * apx - abx * apz, abx * apy - aby * apx);
  if (cross > eps * Math.sqrt(ab2)) return false;
  const t = (apx * abx + apy * aby + apz * abz) / ab2;
  return t > 1e-6 && t < 1 - 1e-6;
}

function samePt(a: [number, number, number], b: [number, number, number], eps = 1e-9): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps;
}

function mergeMeshes(meshes: StencilMesh[]): StencilMesh {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const m of meshes) {
    pos.push(...m.positions);
    nrm.push(...m.normals);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm) };
}

function cylinder(x: number, y: number, r: number, z0: number, z1: number): StencilMesh {
  return extrude([[circleRing(x, y, r)]], z0, z1);
}

function buildJigMesh(
  plate: StencilBounds,
  board: StencilBounds,
  holes: StencilAlignmentHole[],
  options: Required<StencilOptions>,
): StencilMesh {
  const margin = 2;
  const jig = expandBounds(plate, margin);
  const baseH = 3;
  const pocket = options.pcbThicknessMm;
  const wallH = baseH + pocket;
  const base = extrude([[rectRing(jig.minX, jig.minY, jig.maxX, jig.maxY)]], 0, baseH);
  const walls = extrude(
    cutPlate(rectRing(jig.minX, jig.minY, jig.maxX, jig.maxY), [
      rectRing(board.minX, board.minY, board.maxX, board.maxY),
    ]),
    baseH,
    wallH,
  );
  const pegs = holes.map((h) =>
    cylinder(h.x, h.y, Math.max(0.4, h.diameterMm / 2 - 0.15), baseH, wallH + 2),
  );
  return mergeMeshes([base, walls, ...pegs]);
}

/* ── STL I/O and mesh checks ─────────────────────────────────────────────── */

export function encodeBinaryStl(mesh: StencilMesh, header = STL_HEADER): Uint8Array {
  const count = mesh.positions.length / 9;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  const enc = new TextEncoder().encode(header.slice(0, 80));
  out.set(enc, 0);
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const ni = t * 3;
    const pi = t * 9;
    view.setFloat32(o, mesh.normals[ni] ?? 0, true);
    view.setFloat32(o + 4, mesh.normals[ni + 1] ?? 0, true);
    view.setFloat32(o + 8, mesh.normals[ni + 2] ?? 0, true);
    for (let k = 0; k < 9; k++) view.setFloat32(o + 12 + k * 4, mesh.positions[pi + k] ?? 0, true);
    view.setUint16(o + 48, 0, true);
    o += 50;
  }
  return out;
}

export function decodeBinaryStl(data: Uint8Array): StencilMesh {
  if (data.length < 84) throw new Error("STL too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(80, true);
  if (data.length !== 84 + count * 50)
    throw new Error(`STL size mismatch: ${data.length} bytes for ${count} triangles`);
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50;
    normals[t * 3] = view.getFloat32(o, true);
    normals[t * 3 + 1] = view.getFloat32(o + 4, true);
    normals[t * 3 + 2] = view.getFloat32(o + 8, true);
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(o + 12 + k * 4, true);
  }
  return { positions, normals };
}

export type MeshCheck = {
  triangleCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  watertight: boolean;
  unmatchedEdges: number;
};

export function checkMesh(mesh: StencilMesh, eps = 1e-5): MeshCheck {
  const count = mesh.positions.length / 9;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const edges = new Map<string, number>();
  const q = (n: number) => Math.round(n / eps);
  const key = (a: [number, number, number], b: [number, number, number]) => {
    const a1: [number, number, number] = [q(a[0]), q(a[1]), q(a[2])];
    const b1: [number, number, number] = [q(b[0]), q(b[1]), q(b[2])];
    const fwd =
      a1[0] < b1[0] || (a1[0] === b1[0] && (a1[1] < b1[1] || (a1[1] === b1[1] && a1[2] < b1[2])));
    const lo = fwd ? a1 : b1;
    const hi = fwd ? b1 : a1;
    return `${lo[0]},${lo[1]},${lo[2]}>${hi[0]},${hi[1]},${hi[2]}`;
  };
  for (let t = 0; t < count; t++) {
    const p = mesh.positions;
    const i = t * 9;
    const v: Array<[number, number, number]> = [
      [p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0],
      [p[i + 3] ?? 0, p[i + 4] ?? 0, p[i + 5] ?? 0],
      [p[i + 6] ?? 0, p[i + 7] ?? 0, p[i + 8] ?? 0],
    ];
    for (const [x, y, z] of v) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const e = [key(v[0]!, v[1]!), key(v[1]!, v[2]!), key(v[2]!, v[0]!)];
    for (const k of e) edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  let unmatched = 0;
  for (const n of edges.values()) if (n !== 2) unmatched += 1;
  return {
    triangleCount: count,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    watertight: unmatched === 0,
    unmatchedEdges: unmatched,
  };
}

export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0],
      yi = ring[i]![1];
    const xj = ring[j]![0],
      yj = ring[j]![1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
