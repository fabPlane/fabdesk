/**
 * 3D-printed solder-stencil generation from a KiCad board's paste layer.
 * Pure TypeScript: kicadts for the board, polygon-clipping + earcut for the mesh.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import earcut, { flatten } from "earcut";
import { parseKicadPcb } from "kicadts";
import polygonClipping from "polygon-clipping";

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
  ref: string;
  number: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  shape: string;
  layers: string[];
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

export type StencilBounds = { minX: number; minY: number; maxX: number; maxY: number; widthMm: number; heightMm: number };

export type StencilAlignmentHole = { x: number; y: number; diameterMm: number };

export type StencilMesh = {
  /** 9 floats per triangle (v1, v2, v3). */
  positions: Float32Array;
  /** 3 floats per triangle. */
  normals: Float32Array;
};

export type StencilBuild = {
  side: StencilSide;
  pads: StencilPadInfo[];
  apertures: StencilAperture[];
  skipped: StencilPadInfo[];
  board: StencilBounds;
  plate: StencilBounds;
  alignmentHoles: StencilAlignmentHole[];
  warnings: StencilWarning[];
  plateMesh: StencilMesh;
  jigMesh?: StencilMesh;
  options: Required<StencilOptions>;
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
  apertureOffsetMm: 0.05,
  minApertureMm: 0.35,
  skipFinePitch: true,
  finePitchMm: 0.5,
  alignment: "holes" as StencilAlignment,
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

export function buildSolderStencil(pcbText: string, opts: StencilOptions = {}): StencilBuild {
  const options = resolveStencilOptions(opts);
  if (!(options.thicknessMm > 0)) throw new Error("thicknessMm must be > 0");
  if (options.frameMm < 0) throw new Error("frameMm must be >= 0");
  const pcb = parseKicadPcb(pcbText);
  const warnings: StencilWarning[] = [];
  const pads = collectPastePads(pcb, options.side);
  if (pads.length === 0) {
    throw new Error(`no ${options.side}.Paste pads on the board`);
  }
  const board = boardOutline(pcb, pads, warnings, options.includeJig);
  const { apertures, skipped } = selectApertures(pads, options, warnings);
  const plate = expandBounds(board, options.frameMm);
  const alignmentHoles = alignmentHolesFor(pcb, plate, board, options, warnings);
  const holePolys: Ring[] = [
    ...apertures.map((a) => a.polygon),
    ...(options.alignment === "none" ? [] : alignmentHoles.map((h) => circleRing(h.x, h.y, h.diameterMm / 2))),
  ];
  const plate2d = cutPlate(rectRing(plate.minX, plate.minY, plate.maxX, plate.maxY), holePolys);
  const plateMesh = extrude(plate2d, 0, options.thicknessMm);
  let jigMesh: StencilMesh | undefined;
  if (options.includeJig) {
    jigMesh = buildJigMesh(plate, board, alignmentHoles, options);
  }
  if (options.side === "B") {
    warnings.push({
      code: "bottom_view",
      message: "Bottom stencil is as seen from above (KiCad coordinates). Mirror it in the slicer if you print against the board's back.",
    });
  }
  return {
    side: options.side,
    pads,
    apertures,
    skipped,
    board,
    plate,
    alignmentHoles,
    warnings,
    plateMesh,
    ...(jigMesh ? { jigMesh } : {}),
    options,
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
  if (built.jigMesh && jigPath) await writeFile(jigPath, encodeBinaryStl(built.jigMesh, `fabdesk ${stem} jig`));
  const summary = toSummary(built, { stl, json, markdown, svg, ...(jigPath ? { jig: jigPath } : {}) });
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
    apertureCount: built.apertures.length,
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
| Pads on paste layer | ${s.padCount} |
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

Print the STL as a single layer (FDM) or thin resin sheet. Keep the plate on the bed; apertures are through-holes.
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
  const aperturesSvg = apertures.map((a) => ring(a.polygon, ` fill="#111" stroke="none"`)).join("\n");
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
  <text x="${pad}" y="${(h - 0.35).toFixed(3)}" font-size="0.9" font-family="ui-sans-serif,system-ui,sans-serif" fill="#374151">${built.side}.Paste stencil · ${options.thicknessMm} mm · ${apertures.length} apertures</text>
</svg>
`;
}

/* ── board parse ─────────────────────────────────────────────────────────── */

type Pcb = ReturnType<typeof parseKicadPcb>;

function collectPastePads(pcb: Pcb, side: StencilSide): StencilPadInfo[] {
  const out: StencilPadInfo[] = [];
  for (const fp of pcb.footprints) {
    const ref = fp.properties.find((p) => p.key === "Reference")?.value ?? "?";
    const fpAt = xyOf(fp.position);
    const mirrored = (fp.layer?.names ?? []).some((n) => n === "B.Cu");
    for (const pad of fp.fpPads) {
      const layers = pad.layers?.layers ?? [];
      if (!layerHasPaste(layers, side)) continue;
      const size = pad.size;
      if (!size) continue;
      const padAt = xyOf(pad.at);
      const local = mirrored ? { x: -padAt.x, y: padAt.y, angle: -(padAt.angle ?? 0) } : padAt;
      const world = rotate(local.x, local.y, fpAt.angle);
      out.push({
        ref,
        number: pad.number || "",
        x: fpAt.x + world[0],
        y: fpAt.y + world[1],
        width: size.width,
        height: size.height,
        angle: fpAt.angle + local.angle,
        shape: pad.shape || "rect",
        layers,
      });
    }
  }
  return out;
}

function layerHasPaste(layers: string[], side: StencilSide): boolean {
  const want = `${side}.Paste`;
  return layers.some((l) => l === want || l === "*.Paste" || l === "F&B.Paste");
}

const onEdgeCuts = (item: { layer?: { names?: string[] } | undefined }) => (item.layer?.names ?? []).includes("Edge.Cuts");
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
  for (const r of pcb.graphicRects.filter(onEdgeCuts)) pts.push(...xy(r.startPoint), ...xy(r.endPoint));
  for (const poly of pcb.graphicPolys.filter(onEdgeCuts)) {
    for (const p of poly.points?.points ?? []) {
      if ("x" in p && "y" in p && typeof p.x === "number" && typeof p.y === "number") pts.push([p.x, p.y]);
    }
  }
  for (const l of pcb.graphicLines.filter(onEdgeCuts)) pts.push(...xy(l.startPoint), ...xy(l.endPoint));
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
    throw new Error("no Edge.Cuts outline; a jig pocket needs the real board size (draw the outline or omit the jig)");
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
    const fpAt = xyOf(fp.position);
    const mirrored = (fp.layer?.names ?? []).some((n) => n === "B.Cu");
    for (const pad of fp.fpPads) {
      if (pad.padType !== "npth") continue;
      const d = pad.drill?.diameter ?? pad.size?.width ?? 0;
      if (d < 1.5) continue;
      const padAt = xyOf(pad.at);
      const local = mirrored ? { x: -padAt.x, y: padAt.y } : padAt;
      const world = rotate(local.x, local.y, fpAt.angle);
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
      message: "No NPTH tooling holes ≥ 1.5 mm; placing registration holes in the stencil frame corners.",
    });
  }
  const inset = Math.min(options.frameMm * 0.45, 2.2);
  const d = options.alignmentHoleMm;
  const corners: StencilAlignmentHole[] = [
    { x: plate.minX + inset, y: plate.minY + inset, diameterMm: d },
    { x: plate.maxX - inset, y: plate.minY + inset, diameterMm: d },
    { x: plate.maxX - inset, y: plate.maxY - inset, diameterMm: d },
    { x: plate.minX + inset, y: plate.maxY - inset, diameterMm: d },
  ].filter((h) => h.x < board.minX - d / 2 || h.x > board.maxX + d / 2 || h.y < board.minY - d / 2 || h.y > board.maxY + d / 2);
  return [...tooling, ...corners];
}

function selectApertures(
  pads: StencilPadInfo[],
  options: Required<StencilOptions>,
  warnings: StencilWarning[],
): { apertures: StencilAperture[]; skipped: StencilPadInfo[] } {
  const fine = new Set<StencilPadInfo>();
  if (options.skipFinePitch) {
    const byRef = new Map<string, StencilPadInfo[]>();
    for (const p of pads) {
      const list = byRef.get(p.ref) ?? [];
      list.push(p);
      byRef.set(p.ref, list);
    }
    for (const group of byRef.values()) {
      if (group.length < 2) continue;
      let minPitch = Infinity;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          minPitch = Math.min(minPitch, Math.hypot(a.x - b.x, a.y - b.y));
        }
      }
      if (minPitch < options.finePitchMm) {
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
    const w = pad.width - 2 * options.apertureOffsetMm;
    const h = pad.height - 2 * options.apertureOffsetMm;
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
      polygon: padPolygon(pad.x, pad.y, w, h, pad.angle, pad.shape),
    });
  }
  return { apertures, skipped };
}

function padPolygon(x: number, y: number, w: number, h: number, angle: number, shape: string): Ring {
  if (shape === "circle") return circleRing(x, y, Math.min(w, h) / 2);
  if (shape === "oval") return ovalRing(x, y, w, h, angle);
  return rectRingCentered(x, y, w, h, angle);
}

/* ── 2D helpers ──────────────────────────────────────────────────────────── */

function xyOf(p: { x: number; y: number; angle?: number } | undefined): { x: number; y: number; angle: number } {
  if (!p) return { x: 0, y: 0, angle: 0 };
  return { x: p.x, y: p.y, angle: typeof p.angle === "number" ? p.angle : 0 };
}

function rotate(x: number, y: number, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function boundsOf(pts: Vec2[]): StencilBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

function ovalRing(x: number, y: number, w: number, h: number, angle: number, segs = CIRCLE_SEGS): Ring {
  const pts: Ring = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    const [rx, ry] = rotate((w / 2) * Math.cos(t), (h / 2) * Math.sin(t), angle);
    pts.push([x + rx, y + ry]);
  }
  return ensureWinding(pts, true);
}

function cutPlate(outer: Ring, holes: Ring[]): Ring[][] {
  const subject = [closeRing(ensureWinding(outer, true))];
  const clips = holes.filter((h) => h.length >= 3).map((h) => [closeRing(ensureWinding(h, true))]);
  const result = clips.length === 0 ? polygonClipping.union(subject) : polygonClipping.difference(subject, ...clips);
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

function addTri(buf: TriBuf, a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
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
  const qk = (v: [number, number, number]) => `${Math.round(v[0] * 1e6)},${Math.round(v[1] * 1e6)},${Math.round(v[2] * 1e6)}`;
  for (const v of verts) {
    const k = qk(v);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(v);
  }
  const buf: TriBuf = { pos: [], nrm: [] };
  const emit = (a: [number, number, number], b: [number, number, number], c: [number, number, number]): void => {
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

function onSegment(a: [number, number, number], b: [number, number, number], p: [number, number, number], eps = 1e-7): boolean {
  if (samePt(a, p) || samePt(b, p)) return false;
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
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
    cutPlate(rectRing(jig.minX, jig.minY, jig.maxX, jig.maxY), [rectRing(board.minX, board.minY, board.maxX, board.maxY)]),
    baseH,
    wallH,
  );
  const pegs = holes.map((h) => cylinder(h.x, h.y, Math.max(0.4, h.diameterMm / 2 - 0.15), baseH, wallH + 2));
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
  if (data.length !== 84 + count * 50) throw new Error(`STL size mismatch: ${data.length} bytes for ${count} triangles`);
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
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const edges = new Map<string, number>();
  const q = (n: number) => Math.round(n / eps);
  const key = (a: [number, number, number], b: [number, number, number]) => {
    const a1: [number, number, number] = [q(a[0]), q(a[1]), q(a[2])];
    const b1: [number, number, number] = [q(b[0]), q(b[1]), q(b[2])];
    const fwd = a1[0] < b1[0] || (a1[0] === b1[0] && (a1[1] < b1[1] || (a1[1] === b1[1] && a1[2] < b1[2])));
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
    const xi = ring[i]![0], yi = ring[i]![1];
    const xj = ring[j]![0], yj = ring[j]![1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
