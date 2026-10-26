import type {
  BoardDiff,
  BoardSnapshot,
  ComponentChangeReason,
  ComponentSnapshot,
  Point,
  TrackSnapshot,
  ViaSnapshot,
  ZoneSnapshot,
} from "./types";

const COLORS = {
  added: "#16a34a",
  removed: "#dc2626",
  changed: "#d97706",
  unchanged: "#64748b",
  outline: "#0f172a",
  guide: "#94a3b8",
} as const;

export type VisualKind = "pcb" | "schematic";
export type ComponentRole = "added" | "removed" | "changed" | "unchanged";

const SURFACE_REASONS: Record<VisualKind, ReadonlySet<ComponentChangeReason>> = {
  pcb: new Set(["moved", "rotated", "layer", "value", "footprint", "pads"]),
  schematic: new Set(["schematic-moved", "schematic-rotated", "value", "footprint"]),
};

/** With `kind`, a part only counts as changed when a reason applies to that surface. */
export function componentRole(ref: string, diff: BoardDiff, kind?: VisualKind): ComponentRole {
  if (diff.components.added.some((c) => c.ref === ref)) return "added";
  if (diff.components.removed.some((c) => c.ref === ref)) return "removed";
  const change = diff.components.changed.find((c) => c.ref === ref);
  if (change && (!kind || change.reasons.some((r) => SURFACE_REASONS[kind].has(r)))) return "changed";
  return "unchanged";
}

function componentPoint(component: ComponentSnapshot, kind: VisualKind): Point | undefined {
  if (kind === "schematic") {
    if (component.schX === undefined || component.schY === undefined) return undefined;
    return { x: component.schX, y: component.schY };
  }
  if (component.x === undefined || component.y === undefined) return undefined;
  return { x: component.x, y: component.y };
}

/**
 * Finite box for an empty (or non-finite) point set. #239's sharedBounds of two
 * empty boards reduced over `Infinity` and produced an infinite viewBox; this
 * fallback keeps overlay/structured SVGs at `0 0 100 80`.
 */
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 100, maxY: 80 };

function boundsOf(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { ...EMPTY_BOUNDS };
  }
  return { minX, minY, maxX, maxY };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function trackPoints(track: TrackSnapshot): Point[] {
  return track.points && track.points.length >= 2 ? track.points : [track.start, track.end];
}

function collectPoints(snapshot: BoardSnapshot, kind: VisualKind): Point[] {
  const points = [...snapshot.outline];
  for (const c of snapshot.components) {
    const p = componentPoint(c, kind);
    if (p) points.push(p);
  }
  for (const t of snapshot.tracks) {
    if (kind === "schematic" ? t.layer === "schematic" : t.layer !== "schematic") {
      points.push(...trackPoints(t));
    }
  }
  if (kind === "pcb") {
    for (const v of snapshot.vias ?? []) points.push({ x: v.x, y: v.y });
    for (const z of snapshot.zones ?? []) points.push(...z.points);
  }
  return points;
}

function padBox(box: { minX: number; minY: number; maxX: number; maxY: number }, pad: number) {
  return {
    minX: box.minX - pad,
    minY: box.minY - pad,
    maxX: box.maxX + pad,
    maxY: box.maxY + pad,
  };
}

function unionBoxes(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
) {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function viewBoxAttr(box: { minX: number; minY: number; maxX: number; maxY: number }): string {
  const minX = Number.isFinite(box.minX) ? box.minX : 0;
  const minY = Number.isFinite(box.minY) ? box.minY : 0;
  const w = Math.max(1, (Number.isFinite(box.maxX) ? box.maxX : 100) - minX);
  const h = Math.max(1, (Number.isFinite(box.maxY) ? box.maxY : 80) - minY);
  return `${minX} ${minY} ${w} ${h}`;
}

function drawTracks(tracks: TrackSnapshot[], kind: VisualKind, color: string, widthScale = 1): string {
  return tracks
    .filter((t) => (kind === "schematic" ? t.layer === "schematic" : t.layer !== "schematic"))
    .map((t) => {
      const w = kind === "schematic" ? 0.15 : Math.max(0.12, t.width * widthScale);
      const pts = trackPoints(t);
      if (pts.length > 2) {
        return `<polyline data-net="${escapeXml(t.net ?? "")}" data-track="${escapeXml(t.id)}" points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      return `<line data-net="${escapeXml(t.net ?? "")}" data-track="${escapeXml(t.id)}" x1="${t.start.x}" y1="${t.start.y}" x2="${t.end.x}" y2="${t.end.y}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
    })
    .join("");
}

function drawVias(vias: ViaSnapshot[], color: string): string {
  return vias
    .map((v) => {
      const r = Math.max(0.15, v.diameter / 2);
      return `<circle cx="${v.x}" cy="${v.y}" r="${r}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="${Math.max(0.08, v.diameter * 0.12)}" data-via="${escapeXml(v.id)}" data-net="${escapeXml(v.net ?? "")}"/>`;
    })
    .join("");
}

function drawZones(zones: ZoneSnapshot[], color: string): string {
  return zones
    .map((z) => {
      if (z.points.length < 3) return "";
      const d = z.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
      return `<path d="${d}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="0.15" data-zone="${escapeXml(z.id)}" data-net="${escapeXml(z.net ?? "")}"/>`;
    })
    .join("");
}

function drawComponent(component: ComponentSnapshot, kind: VisualKind, color: string, size: number): string {
  const p = componentPoint(component, kind);
  if (!p) return "";
  const label = escapeXml(component.ref);
  return `<g data-ref="${label}" class="board-diff-part">
    <rect x="${p.x - size / 2}" y="${p.y - size / 2}" width="${size}" height="${size}" rx="${size * 0.15}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="${size * 0.08}"/>
    <text x="${p.x}" y="${p.y + size * 0.18}" text-anchor="middle" font-size="${size * 0.55}" font-family="ui-sans-serif,system-ui,sans-serif" fill="${color}">${label}</text>
  </g>`;
}

function drawOutline(outline: Point[], color: string): string {
  if (outline.length < 2) return "";
  if (outline.length === 2) {
    const a = outline[0]!;
    const b = outline[1]!;
    return `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="none" stroke="${color}" stroke-width="0.2"/>`;
  }
  const d = outline.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="0.2"/>`;
}

function drawMoves(diff: BoardDiff, kind: VisualKind): string {
  const partMoves = diff.components.changed
    .filter((c) => c.reasons.includes(kind === "schematic" ? "schematic-moved" : "moved"))
    .map((c) => {
      const a = componentPoint(c.before, kind);
      const b = componentPoint(c.after, kind);
      if (!a || !b) return "";
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${COLORS.changed}" stroke-width="0.12" stroke-dasharray="0.4 0.3" marker-end="url(#board-diff-arrow)"/>`;
    });
  const viaMoves =
    kind === "pcb"
      ? diff.vias.changed
          .filter((c) => c.reasons.includes("moved"))
          .map(
            (c) =>
              `<line x1="${c.before.x}" y1="${c.before.y}" x2="${c.after.x}" y2="${c.after.y}" stroke="${COLORS.changed}" stroke-width="0.1" stroke-dasharray="0.3 0.2"/>`,
          )
      : [];
  return [...partMoves, ...viaMoves].join("");
}

function copperIds(diff: BoardDiff): { tracks: Set<string>; vias: Set<string>; zones: Set<string> } {
  const tracks = new Set<string>([...diff.tracks.added, ...diff.tracks.removed].map((t) => t.id));
  const vias = new Set<string>();
  for (const v of diff.vias.added) vias.add(v.id);
  for (const v of diff.vias.removed) vias.add(v.id);
  for (const v of diff.vias.changed) {
    vias.add(v.before.id);
    vias.add(v.after.id);
  }
  const zones = new Set<string>();
  for (const z of diff.zones.added) zones.add(z.id);
  for (const z of diff.zones.removed) zones.add(z.id);
  for (const z of diff.zones.changed) {
    zones.add(z.before.id);
    zones.add(z.after.id);
  }
  return { tracks, vias, zones };
}

function snapshotSvgBody(snapshot: BoardSnapshot, diff: BoardDiff, kind: VisualKind, roleForMissing: ComponentRole): string {
  const size = kind === "schematic" ? 2.4 : 1.6;
  const parts = snapshot.components
    .map((c) => {
      const role = componentRole(c.ref, diff, kind);
      const color = COLORS[role === "unchanged" && roleForMissing !== "unchanged" ? roleForMissing : role];
      return drawComponent(c, kind, color, size);
    })
    .join("");
  const dirty = copperIds(diff);
  const unchangedTracks = snapshot.tracks.filter((t) => !dirty.tracks.has(t.id));
  const unchangedVias = kind === "pcb" ? (snapshot.vias ?? []).filter((v) => !dirty.vias.has(v.id)) : [];
  const unchangedZones = kind === "pcb" ? (snapshot.zones ?? []).filter((z) => !dirty.zones.has(z.id)) : [];
  return `${drawOutline(snapshot.outline, COLORS.outline)}${drawZones(unchangedZones, COLORS.unchanged)}${drawTracks(unchangedTracks, kind, COLORS.unchanged)}${drawVias(unchangedVias, COLORS.unchanged)}${parts}`;
}

/** Single-revision drawing used for overlay / side-by-side when KiCad SVGs are absent. */
export function snapshotSvg(snapshot: BoardSnapshot, kind: VisualKind = "pcb", color: string = COLORS.unchanged): string {
  const box = padBox(boundsOf(collectPoints(snapshot, kind)), kind === "schematic" ? 8 : 4);
  const size = kind === "schematic" ? 2.4 : 1.6;
  const parts = snapshot.components.map((c) => drawComponent(c, kind, color, size)).join("");
  const tracks = drawTracks(snapshot.tracks, kind, color);
  const vias = kind === "pcb" ? drawVias(snapshot.vias ?? [], color) : "";
  const zones = kind === "pcb" ? drawZones(snapshot.zones ?? [], color) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBoxAttr(box)}" data-board-diff="${kind}-revision">
  <rect data-board-diff-background="true" x="${box.minX}" y="${box.minY}" width="${box.maxX - box.minX}" height="${box.maxY - box.minY}" fill="#ffffff"/>
  ${drawOutline(snapshot.outline, COLORS.outline)}
  ${zones}
  ${tracks}
  ${vias}
  ${parts}
</svg>
`;
}

/** Structured visual: added green, removed red, moved/changed amber, with move arrows. */
export function visualDiffSvg(from: BoardSnapshot, to: BoardSnapshot, diff: BoardDiff, kind: VisualKind = "pcb"): string {
  const box = padBox(
    unionBoxes(boundsOf(collectPoints(from, kind)), boundsOf(collectPoints(to, kind))),
    kind === "schematic" ? 8 : 4,
  );
  const font = Math.max(1.2, (box.maxX - box.minX) * 0.03);
  const addedTracks = drawTracks(diff.tracks.added, kind, COLORS.added);
  const removedTracks = drawTracks(diff.tracks.removed, kind, COLORS.removed);
  const addedVias = kind === "pcb" ? drawVias(diff.vias.added, COLORS.added) : "";
  const removedVias = kind === "pcb" ? drawVias(diff.vias.removed, COLORS.removed) : "";
  const changedVias = kind === "pcb" ? drawVias(diff.vias.changed.map((c) => c.after), COLORS.changed) : "";
  const addedZones = kind === "pcb" ? drawZones(diff.zones.added, COLORS.added) : "";
  const removedZones = kind === "pcb" ? drawZones(diff.zones.removed, COLORS.removed) : "";
  const changedZones = kind === "pcb" ? drawZones(diff.zones.changed.map((c) => c.after), COLORS.changed) : "";
  const fromOnly = {
    ...from,
    components: from.components.filter((c) => diff.components.removed.some((r) => r.ref === c.ref)),
    tracks: [],
    vias: [],
    zones: [],
    outline: kind === "pcb" ? from.outline : [],
  };
  const toBody = snapshotSvgBody(to, diff, kind, "unchanged");
  const removedBody = snapshotSvgBody(fromOnly, diff, kind, "removed");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBoxAttr(box)}" data-board-diff="${kind}">
  <defs>
    <marker id="board-diff-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${COLORS.changed}"/>
    </marker>
  </defs>
  <rect x="${box.minX}" y="${box.minY}" width="${box.maxX - box.minX}" height="${box.maxY - box.minY}" fill="#f8fafc"/>
  ${toBody}
  ${removedBody}
  ${removedZones}
  ${addedZones}
  ${changedZones}
  ${removedTracks}
  ${addedTracks}
  ${removedVias}
  ${addedVias}
  ${changedVias}
  ${drawMoves(diff, kind)}
  <text x="${box.minX + font * 0.4}" y="${box.minY + font}" font-size="${font}" font-family="ui-sans-serif,system-ui,sans-serif" fill="${COLORS.guide}">${kind === "pcb" ? "PCB" : "Schematic"} · green added · red removed · amber moved/changed</text>
</svg>
`;
}

export function parseViewBox(svg: string): { x: number; y: number; w: number; h: number } | undefined {
  const match = /viewBox\s*=\s*"([^"]+)"/.exec(svg) ?? /viewBox\s*=\s*'([^']+)'/.exec(svg);
  if (!match?.[1]) return undefined;
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
}

export function extractSvgInner(svg: string): { viewBox?: string; inner: string } {
  const viewBox = /viewBox\s*=\s*"([^"]+)"/.exec(svg)?.[1];
  const inner = svg
    .replace(/<\?xml[^>]*>/i, "")
    .replace(/<!DOCTYPE[^>]*>/i, "")
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
  return { ...(viewBox ? { viewBox } : {}), inner };
}

/** Recolor explicit fill/stroke so two KiCad SVGs can be overlaid as a red/green revision pair. */
export function colorizeSvgMarkup(inner: string, color: string): string {
  return inner
    // Snapshot backgrounds belong to the canvas, not either revision's geometry.
    .replace(/<rect\b[^>]*\bdata-board-diff-background="true"[^>]*\/>/gi, "")
    .replace(/\sfill="(?!none|transparent|url\()[^"]*"/gi, ` fill="${color}"`)
    .replace(/\sstroke="(?!none|transparent|url\()[^"]*"/gi, ` stroke="${color}"`)
    .replace(/\sfill='(?!none|transparent|url\()[^']*'/gi, ` fill="${color}"`)
    .replace(/\sstroke='(?!none|transparent|url\()[^']*'/gi, ` stroke="${color}"`);
}

function finiteBox(values: number[] | undefined): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (!values || values.length < 4 || values.slice(0, 4).some((n) => !Number.isFinite(n))) return undefined;
  return { minX: values[0]!, minY: values[1]!, maxX: values[0]! + values[2]!, maxY: values[1]! + values[3]! };
}

function unionViewBox(a?: string, b?: string): string {
  const pa = a ? a.trim().split(/[\s,]+/).map(Number) : undefined;
  const pb = b ? b.trim().split(/[\s,]+/).map(Number) : undefined;
  const boxA = finiteBox(pa);
  const boxB = finiteBox(pb);
  if (boxA && boxB) return viewBoxAttr(unionBoxes(boxA, boxB));
  if (a && boxA) return a;
  if (b && boxB) return b;
  return "0 0 100 80";
}

/** Prefix `id` attributes and rewrite `url(#…)` / href references so overlay layers do not collide. */
export function prefixSvgIds(markup: string, prefix: string): string {
  const ids = new Set<string>();
  for (const match of markup.matchAll(/\bid="([^"]+)"/g)) {
    if (match[1]) ids.add(match[1]);
  }
  for (const match of markup.matchAll(/\bid='([^']+)'/g)) {
    if (match[1]) ids.add(match[1]);
  }
  if (ids.size === 0) return markup;
  const sorted = [...ids].sort((a, b) => b.length - a.length);
  let out = markup;
  for (const id of sorted) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\bid="${escaped}"`, "g"), `id="${prefix}${id}"`);
    out = out.replace(new RegExp(`\\bid='${escaped}'`, "g"), `id='${prefix}${id}'`);
    out = out.replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}${id})`);
    out = out.replace(new RegExp(`url\\(['"]#${escaped}['"]\\)`, "g"), `url(#${prefix}${id})`);
    out = out.replace(new RegExp(`((?:xlink:)?href=["'])#${escaped}(["'])`, "g"), `$1#${prefix}${id}$2`);
  }
  return out;
}

/** Classic red-under / green-over overlay of two KiCad (or generated) SVGs. */
export function overlaySvgs(fromSvg: string, toSvg: string): string {
  const from = extractSvgInner(fromSvg);
  const to = extractSvgInner(toSvg);
  const viewBox = unionViewBox(from.viewBox, to.viewBox);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" data-board-diff="overlay">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g class="board-diff-removed" opacity="0.55">${prefixSvgIds(colorizeSvgMarkup(from.inner, COLORS.removed), "removed-")}</g>
  <g class="board-diff-added" opacity="0.55">${prefixSvgIds(colorizeSvgMarkup(to.inner, COLORS.added), "added-")}</g>
</svg>
`;
}

export function sideBySideSvgs(fromSvg: string, toSvg: string, fromLabel = "From", toLabel = "To"): string {
  const from = extractSvgInner(fromSvg);
  const to = extractSvgInner(toSvg);
  const a = parseViewBox(`<svg viewBox="${from.viewBox ?? "0 0 100 80"}">`) ?? { x: 0, y: 0, w: 100, h: 80 };
  const b = parseViewBox(`<svg viewBox="${to.viewBox ?? "0 0 100 80"}">`) ?? { x: 0, y: 0, w: 100, h: 80 };
  const h = Math.max(a.h, b.h);
  const gap = Math.max(a.w, b.w) * 0.06;
  const width = a.w + b.w + gap;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h + h * 0.08}" data-board-diff="side-by-side">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <svg x="0" y="${h * 0.08}" width="${a.w}" height="${h}" viewBox="${a.x} ${a.y} ${a.w} ${a.h}">${prefixSvgIds(from.inner, "from-")}</svg>
  <svg x="${a.w + gap}" y="${h * 0.08}" width="${b.w}" height="${h}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">${prefixSvgIds(to.inner, "to-")}</svg>
  <text x="${a.w / 2}" y="${h * 0.06}" text-anchor="middle" font-size="${h * 0.045}" font-family="ui-sans-serif,system-ui,sans-serif" fill="${COLORS.removed}">${escapeXml(fromLabel)}</text>
  <text x="${a.w + gap + b.w / 2}" y="${h * 0.06}" text-anchor="middle" font-size="${h * 0.045}" font-family="ui-sans-serif,system-ui,sans-serif" fill="${COLORS.added}">${escapeXml(toLabel)}</text>
</svg>
`;
}
