import { BOARD_FINISH, type Primitive, type ResolvedArtOptions } from "./types";
import { outlinePrimitives } from "./gerber";

export function previewSvg(o: ResolvedArtOptions, art: readonly Primitive[]): string {
  const finish = BOARD_FINISH[o.color];
  const pad = 4;
  const w = o.widthMm + pad * 2;
  const h = o.heightMm + pad * 2;
  const clipId = "board";
  const path = outlinePath(o);
  const body = art.map((p) => primSvg(p, finish.silk)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${w} ${h}" width="${Math.round(w * 8)}" height="${Math.round(h * 8)}">
  <defs>
    <clipPath id="${clipId}">${outlineFill(o)}</clipPath>
  </defs>
  <rect x="${-pad}" y="${-pad}" width="${w}" height="${h}" fill="#111"/>
  <g clip-path="url(#${clipId})">
    <rect x="0" y="0" width="${o.widthMm}" height="${o.heightMm}" fill="${finish.copper}"/>
    <rect x="0" y="0" width="${o.widthMm}" height="${o.heightMm}" fill="${finish.mask}" fill-opacity="0.92"/>
    ${body}
  </g>
  <path d="${path}" fill="none" stroke="#0a0a0a" stroke-width="0.25"/>
</svg>
`;
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
