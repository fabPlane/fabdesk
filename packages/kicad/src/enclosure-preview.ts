/**
 * Top + isometric SVG preview of a parametric enclosure (board, offset cavity, vents, snap clips).
 */
import type { EnclosureSolid, EnclosureSpec } from "./enclosure";

const mm = (n: number) => Math.round(n * 1e4) / 1e4;

const ROLE_FILL: Record<EnclosureSolid["role"], string> = {
  floor: "#2b332c",
  wall: "#4d7d32",
  lid: "#c5d6b0",
  lip: "#8aa078",
  standoff: "#657365",
  clip: "#b9f45d",
};

const ROLE_STROKE: Record<EnclosureSolid["role"], string> = {
  floor: "#1d281b",
  wall: "#243321",
  lid: "#456f32",
  lip: "#456f32",
  standoff: "#1d281b",
  clip: "#243321",
};

function iso(x: number, y: number, z: number): { x: number; y: number } {
  return {
    x: (x - y) * Math.cos(Math.PI / 6),
    y: (x + y) * Math.sin(Math.PI / 6) - z,
  };
}

function poly(points: Array<{ x: number; y: number }>, fill: string, stroke: string, extra = ""): string {
  const d = points.map((p) => `${mm(p.x)},${mm(p.y)}`).join(" ");
  return `<polygon points="${d}" fill="${fill}" stroke="${stroke}" stroke-width="0.18" ${extra}/>`;
}

function boxFaces(s: EnclosureSolid): string[] {
  const { min, max } = s;
  const fill = ROLE_FILL[s.role];
  const stroke = ROLE_STROKE[s.role];
  const top = [iso(min.x, min.y, max.z), iso(max.x, min.y, max.z), iso(max.x, max.y, max.z), iso(min.x, max.y, max.z)];
  const right = [iso(max.x, min.y, min.z), iso(max.x, max.y, min.z), iso(max.x, max.y, max.z), iso(max.x, min.y, max.z)];
  const left = [iso(min.x, max.y, min.z), iso(max.x, max.y, min.z), iso(max.x, max.y, max.z), iso(min.x, max.y, max.z)];
  return [
    poly(right, fill, stroke),
    poly(left, fill, stroke),
    poly(top, fill, stroke, `data-role="${s.role}"`),
  ];
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  extra = "",
): string {
  return `<rect x="${mm(x)}" y="${mm(y)}" width="${mm(w)}" height="${mm(h)}" fill="${fill}" stroke="${stroke}" stroke-width="0.2" ${extra}/>`;
}

/** SVG preview: plan (board + offset + vents + clips) and an isometric of the solids. */
export function previewEnclosureSvg(spec: EnclosureSpec): string {
  const { board, inner, outer } = spec;
  const params = spec.params;
  const offsetMm = params.outlineOffsetMm ?? 0;
  const clearanceMm = params.clearanceMm ?? 0;
  const vents = spec.vents ?? [];
  const clips = spec.clips ?? [];
  const pad = 6;
  const planW = outer.maxX - outer.minX;
  const planH = outer.maxY - outer.minY;
  const clearance = {
    minX: board.outline.minX - clearanceMm,
    minY: board.outline.minY - clearanceMm,
    maxX: board.outline.maxX + clearanceMm,
    maxY: board.outline.maxY + clearanceMm,
  };

  const solids = [...spec.solids].sort((a, b) => {
    const da = a.min.x + a.min.y + a.min.z;
    const db = b.min.x + b.min.y + b.min.z;
    return da - db;
  });
  const isoParts = solids.flatMap((s) => (s.kind === "box" ? boxFaces(s) : []));
  let isoMinX = Infinity;
  let isoMinY = Infinity;
  let isoMaxX = -Infinity;
  let isoMaxY = -Infinity;
  for (const s of solids) {
    for (const z of [s.min.z, s.max.z]) {
      for (const p of [
        iso(s.min.x, s.min.y, z),
        iso(s.max.x, s.min.y, z),
        iso(s.max.x, s.max.y, z),
        iso(s.min.x, s.max.y, z),
      ]) {
        isoMinX = Math.min(isoMinX, p.x);
        isoMinY = Math.min(isoMinY, p.y);
        isoMaxX = Math.max(isoMaxX, p.x);
        isoMaxY = Math.max(isoMaxY, p.y);
      }
    }
  }
  const isoW = Math.max(isoMaxX - isoMinX, 1);
  const isoH = Math.max(isoMaxY - isoMinY, 1);
  const panelW = 220;
  const panelH = 200;
  const planScale = Math.min((panelW - 2 * pad) / planW, (panelH - 64) / planH);
  const isoScale = Math.min((panelW - 2 * pad) / isoW, (panelH - 64) / isoH);

  const planOx = pad - outer.minX * planScale;
  const planOy = 56 - outer.minY * planScale;
  const toPlan = (x: number, y: number) => ({ x: planOx + x * planScale, y: planOy + y * planScale });

  const plan: string[] = [];
  const o0 = toPlan(outer.minX, outer.minY);
  plan.push(rect(o0.x, o0.y, planW * planScale, planH * planScale, "#1e231f", "#addb75", `data-layer="outer"`));
  const i0 = toPlan(inner.minX, inner.minY);
  plan.push(
    rect(
      i0.x,
      i0.y,
      (inner.maxX - inner.minX) * planScale,
      (inner.maxY - inner.minY) * planScale,
      "#2b332c",
      "#7fae5e",
      `data-layer="inner"`,
    ),
  );
  const c0 = toPlan(clearance.minX, clearance.minY);
  plan.push(
    rect(
      c0.x,
      c0.y,
      (clearance.maxX - clearance.minX) * planScale,
      (clearance.maxY - clearance.minY) * planScale,
      "none",
      "#e0b24a",
      `stroke-dasharray="1.2 0.8" data-layer="clearance"`,
    ),
  );
  const b0 = toPlan(board.outline.minX, board.outline.minY);
  plan.push(
    rect(
      b0.x,
      b0.y,
      board.outline.widthMm * planScale,
      board.outline.heightMm * planScale,
      "#456f3222",
      "#b9f45d",
      `data-layer="board"`,
    ),
  );
  for (const v of vents) {
    const p = toPlan(v.min.x, v.min.y);
    plan.push(
      rect(
        p.x,
        p.y,
        Math.max((v.max.x - v.min.x) * planScale, 0.6),
        Math.max((v.max.y - v.min.y) * planScale, 0.6),
        v.face === "lid" ? "#191d1a" : "#101a0a",
        "#aab8a6",
        `data-layer="vent" data-vent="${v.id}"`,
      ),
    );
  }
  for (const clip of clips) {
    const p = toPlan(clip.x - clip.widthMm / 2, clip.y - 1);
    plan.push(
      rect(p.x, p.y, clip.widthMm * planScale, 2 * planScale, "#b9f45d", "#243321", `data-layer="clip" data-clip="${clip.id}"`),
    );
  }
  for (const s of spec.standoffs) {
    const p = toPlan(s.x, s.y);
    plan.push(
      `<circle cx="${mm(p.x)}" cy="${mm(p.y)}" r="${mm((s.outerDiameterMm / 2) * planScale)}" fill="none" stroke="#aab8a6" stroke-width="0.3" data-layer="standoff"/>`,
    );
  }

  const isoOx = panelW + pad - isoMinX * isoScale;
  const isoOy = 56 - isoMinY * isoScale;
  const isoMarkup = isoParts
    .join("")
    .replace(/points="([^"]+)"/g, (_m, pts: string) => {
      const mapped = pts
        .split(" ")
        .map((pair) => {
          const [x, y] = pair.split(",").map(Number);
          return `${mm(isoOx + (x ?? 0) * isoScale)},${mm(isoOy + (y ?? 0) * isoScale)}`;
        })
        .join(" ");
      return `points="${mapped}"`;
    });

  const ventNote =
    params.ventPattern === "none" ? "vents off" : `${vents.length} ${params.ventPattern} vent(s)`;
  const snapNote = params.snapFit ? `${clips.length} snap clip(s)` : "no snap-fits";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${panelW * 2} ${panelH}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" data-testid="enclosure-preview-svg" role="img" aria-label="Enclosure preview">`,
    `<rect width="100%" height="100%" fill="var(--bg, #191d1a)"/>`,
    `<text x="${pad}" y="16" fill="var(--fg, #eef3e9)" font-size="11" font-family="Inter, system-ui, sans-serif">Plan</text>`,
    `<text x="${pad}" y="31" fill="var(--fg, #eef3e9)" font-size="10" font-family="Inter, system-ui, sans-serif">offset ${offsetMm} mm</text>`,
    `<text x="${pad}" y="44" fill="var(--fg, #eef3e9)" font-size="10" font-family="Inter, system-ui, sans-serif">clearance ${clearanceMm} mm</text>`,
    `<text x="${panelW + pad}" y="16" fill="var(--fg, #eef3e9)" font-size="11" font-family="Inter, system-ui, sans-serif">Isometric</text>`,
    `<text x="${panelW + pad}" y="31" fill="var(--fg, #eef3e9)" font-size="10" font-family="Inter, system-ui, sans-serif">${ventNote}</text>`,
    `<text x="${panelW + pad}" y="44" fill="var(--fg, #eef3e9)" font-size="10" font-family="Inter, system-ui, sans-serif">${snapNote}</text>`,
    `<g data-view="plan">${plan.join("")}</g>`,
    `<g data-view="iso">${isoMarkup}</g>`,
    `</svg>`,
    "",
  ].join("");
}
