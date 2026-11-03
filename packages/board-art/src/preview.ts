import { BOARD_FINISH, type Primitive, type ResolvedArtOptions, type BoardArt } from "./types";
import { outlinePrimitives } from "./gerber";

/**
 * Composite the layers the Gerber set actually carries: FR4, copper (art or flood fill), soldermask
 * with art-shaped openings when mask is selected, and silkscreen art only when silk is selected.
 */
export function previewSvg(
  o: ResolvedArtOptions,
  art: readonly Primitive[],
  printOnly = false,
  boardOnly = false,
): string {
  const finish = BOARD_FINISH[o.color];
  // Image downloads keep the physical finish, but omit the preview's surrounding stage.
  const pad = printOnly || boardOnly ? 0 : 4;
  const w = o.widthMm + pad * 2;
  const h = o.heightMm + pad * 2;
  const resourceId = previewResourceId(o, art);
  const clipId = `${resourceId}-outline`;
  const maskId = `${resourceId}-mask`;
  const path = outlinePath(o);
  const silkArt = o.layers.includes("silk");
  const maskArt = o.layers.includes("mask");
  const copperArt = o.layers.includes("copper");
  const board = `x="0" y="0" width="${o.widthMm}" height="${o.heightMm}"`;
  const copper = copperArt
    ? `<g data-layer="copper">${art.map((p) => primSvg(p, finish.copper)).join("")}</g>`
    : o.fillCopper
      ? `<rect data-layer="copper-fill" ${board} fill="${finish.copper}"/>`
      : "";
  const maskDef = maskArt
    ? `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${o.widthMm}" height="${o.heightMm}"><rect ${board} fill="#fff"/>${art.map((p) => primSvg(p, "#000")).join("")}</mask>`
    : "";
  const silk = silkArt
    ? `<g data-layer="silk">${art.map((p) => primSvg(p, o.colorMode === "multicolor" ? (p.color ?? o.inkColor) : o.inkColor)).join("")}</g>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${w} ${h}" width="${w}mm" height="${h}mm" data-layers="${o.layers.join(" ")}">
  <defs>
    <clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${outlineFill(o)}</clipPath>
    ${maskDef}
  </defs>
  ${printOnly || boardOnly ? "" : `<rect x="${-pad}" y="${-pad}" width="${w}" height="${h}" fill="#111"/>`}
  <g clip-path="url(#${clipId})">
    ${printOnly ? "" : `<rect data-layer="fr4" ${board} fill="${finish.fr4}"/>`}
    ${printOnly ? "" : copper}
    ${printOnly ? "" : `<rect data-layer="mask" ${board} fill="${finish.mask}" fill-opacity="${o.colorMode === "multicolor" ? 1 : 0.75}"${maskArt ? ` mask="url(#${maskId})"` : ""}/>`}
    ${o.colorMode === "multicolor" && o.printedBackground ? `<rect data-layer="printed-background" ${board} fill="${o.printedBackground}"/>` : ""}
    ${silk}
  </g>
  ${printOnly ? "" : `<path d="${path}" fill="none" stroke="#0a0a0a" stroke-width="0.25"/>`}
</svg>
`;
}

/** Transparent proposal layer for an existing PCB; never paints a new board or copper fill. */
export function artworkOverlaySvg(art: BoardArt): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${art.options.widthMm} ${art.options.heightMm}" width="${art.options.widthMm}" height="${art.options.heightMm}" data-unapplied-artwork="true">${art.clipped.map(primitive => primSvg(primitive, "#f4bd4f")).join("")}</svg>`;
}

function primSvg(p: Primitive, fill: string): string {
  if (p.kind === "circle") {
    return `<circle cx="${p.x}" cy="${p.y}" r="${p.d / 2}" fill="${fill}"/>`;
  }
  if (p.kind === "rect") {
    return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${fill}"/>`;
  }
  return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${fill}" stroke-width="${p.w}" stroke-linecap="round"/>`;
}

function outlineFill(o: ResolvedArtOptions): string {
  if (o.outline === "circle") {
    const r = Math.min(o.widthMm, o.heightMm) / 2;
    return `<circle cx="${o.widthMm / 2}" cy="${o.heightMm / 2}" r="${r}"/>`;
  }
  if (o.outline === "rounded") {
    const r = Math.min(o.widthMm, o.heightMm) * 0.08;
    return `<rect x="0" y="0" width="${o.widthMm}" height="${o.heightMm}" rx="${r}" ry="${r}"/>`;
  }
  return `<rect x="0" y="0" width="${o.widthMm}" height="${o.heightMm}"/>`;
}

function outlinePath(o: ResolvedArtOptions): string {
  const lines = outlinePrimitives(o);
  const first = lines[0];
  if (!first || first.kind !== "line") return "";
  let d = `M ${first.x1} ${first.y1}`;
  for (const p of lines) {
    if (p.kind === "line") d += ` L ${p.x2} ${p.y2}`;
  }
  return `${d} Z`;
}

/** Inline SVG fragment IDs share the document namespace (the app already has id="board").
 * Include the entire scene so different previews cannot borrow each other's clips or masks.
 * Identical scenes deliberately share identical resources to keep exports deterministic.
 */
function previewResourceId(o: ResolvedArtOptions, art: readonly Primitive[]): string {
  const scene = JSON.stringify([o, art]);
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < scene.length; i++) {
    const code = scene.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b, 33) ^ code;
  }
  return `fp-board-art-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
