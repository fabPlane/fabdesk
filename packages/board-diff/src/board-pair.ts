/**
 * Two boards drawn at one physical scale with parts tagged by what changed. Revision comparison and
 * cross-board inspection share this. Footprints are drawn from pads, not silkscreen or courtyards.
 */
import { diffBoards } from "./diff";
import { drawOutline, drawTracks, drawVias, drawZones } from "./svg";
import type { BoardDiff, BoardSnapshot, ComponentSnapshot, DiffOptions, Point } from "./types";

export type BoardBox = { minX: number; minY: number; maxX: number; maxY: number };
export type BoardPartRole = "added" | "removed" | "moved" | "changed" | "unchanged";
export type BoardPartChange = {
  kind: Exclude<BoardPartRole, "unchanged"> | "renamed";
  /** Reference on each side; a rename has both, added and removed parts have one. */
  fromRef?: string;
  toRef?: string;
  value?: string;
  footprint?: string;
  reasons: string[];
  dx?: number;
  dy?: number;
  distance?: number;
};
export type BoardPairComparison = {
  from: BoardSnapshot;
  to: BoardSnapshot;
  diff: BoardDiff;
  changes: BoardPartChange[];
  summary: Record<BoardPartChange["kind"] | "unchanged", number>;
};

const ROLE_COLORS: Record<BoardPartRole, string> = {
  added: "#16a34a",
  removed: "#dc2626",
  moved: "#d97706",
  changed: "#d97706",
  unchanged: "#64748b",
};
const MUTED_COPPER = "#cbd5e1";
const FALLBACK_PART_SIZE = 1.6;

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const round = (value: number) => Math.round(value * 10000) / 10000;

export function padWorldPoint(component: ComponentSnapshot, x: number, y: number): Point {
  const angle = ((component.rotation ?? 0) * Math.PI) / 180;
  return {
    x: round((component.x ?? 0) + x * Math.cos(angle) + y * Math.sin(angle)),
    y: round((component.y ?? 0) - x * Math.sin(angle) + y * Math.cos(angle)),
  };
}

function boxOf(points: Point[]): BoardBox | null {
  const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!finite.length) return null;
  return {
    minX: Math.min(...finite.map((p) => p.x)),
    minY: Math.min(...finite.map((p) => p.y)),
    maxX: Math.max(...finite.map((p) => p.x)),
    maxY: Math.max(...finite.map((p) => p.y)),
  };
}

/** Bounds of a placed part from its pads, or a small square when the footprint has none. */
export function boardPartBounds(component: ComponentSnapshot): BoardBox | null {
  if (component.x === undefined || component.y === undefined) return null;
  const corners = (component.pads ?? []).flatMap((pad) => {
    if (pad.x === undefined || pad.y === undefined) return [];
    const center = padWorldPoint(component, pad.x, pad.y);
    const halfW = (pad.width ?? 0.5) / 2, halfH = (pad.height ?? 0.5) / 2;
    const angle = ((pad.angle ?? 0) * Math.PI) / 180;
    return [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([x, y]) => ({
      x: center.x + x! * Math.cos(angle) + y! * Math.sin(angle),
      y: center.y - x! * Math.sin(angle) + y! * Math.cos(angle),
    }));
  });
  const half = FALLBACK_PART_SIZE / 2;
  return boxOf(corners) ?? { minX: component.x - half, minY: component.y - half, maxX: component.x + half, maxY: component.y + half };
}

export type BoardPadBox = { pin: string; net?: string; bounds: BoardBox };

/** Each numbered pad's placed bounds, for picking a pin instead of a whole part. */
export function boardPadBoxes(component: ComponentSnapshot): BoardPadBox[] {
  return (component.pads ?? []).flatMap((pad) => {
    if (pad.x === undefined || pad.y === undefined) return [];
    const center = padWorldPoint(component, pad.x, pad.y);
    const halfW = (pad.width ?? 0.5) / 2, halfH = (pad.height ?? 0.5) / 2;
    const angle = ((pad.angle ?? 0) * Math.PI) / 180;
    const bounds = boxOf([[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]].map(([x, y]) => ({
      x: center.x + x! * Math.cos(angle) + y! * Math.sin(angle),
      y: center.y - x! * Math.sin(angle) + y! * Math.cos(angle),
    })));
    return bounds ? [{ pin: pad.pin, ...(pad.net ? { net: pad.net } : {}), bounds }] : [];
  });
}

/** Physical board size from Edge.Cuts; null when the board declares no outline. */
export function boardSize(snapshot: BoardSnapshot): { width: number; height: number } | null {
  const box = boxOf(snapshot.outline);
  return box ? { width: round(box.maxX - box.minX), height: round(box.maxY - box.minY) } : null;
}

/** Re-express a board relative to its outline corner, so sheet position is never a design change. */
export function normalizeBoardOrigin(snapshot: BoardSnapshot): BoardSnapshot {
  const box = boxOf(snapshot.outline);
  if (!box || (box.minX === 0 && box.minY === 0)) return snapshot;
  const move = (p: Point): Point => ({ x: round(p.x - box.minX), y: round(p.y - box.minY) });
  return {
    ...snapshot,
    components: snapshot.components.map((c) => (c.x === undefined || c.y === undefined ? c : { ...c, ...move({ x: c.x, y: c.y }) })),
    tracks: snapshot.tracks.map((t) => ({
      ...t,
      start: move(t.start),
      end: move(t.end),
      ...(t.points ? { points: t.points.map(move) } : {}),
    })),
    vias: snapshot.vias.map((v) => ({ ...v, ...move({ x: v.x, y: v.y }) })),
    zones: snapshot.zones.map((z) => ({ ...z, points: z.points.map(move) })),
    outline: snapshot.outline.map(move),
    ...(snapshot.outlinePaths ? { outlinePaths: snapshot.outlinePaths.map((path) => path.map(move)) } : {}),
  };
}

function identityMatches(a: ComponentSnapshot, b: ComponentSnapshot): boolean {
  return a.symbolPath && b.symbolPath ? a.symbolPath === b.symbolPath : !!a.uuid && a.uuid === b.uuid;
}

/** Compare two PCB revisions in outline coordinates, reporting renames only on a native identity match. */
export function compareBoardPair(fromRaw: BoardSnapshot, toRaw: BoardSnapshot, opts: DiffOptions = {}): BoardPairComparison {
  const from = normalizeBoardOrigin(fromRaw), to = normalizeBoardOrigin(toRaw);
  const diff = diffBoards(from, to, opts);
  const added = [...diff.components.added];
  const changes: BoardPartChange[] = [];
  for (const old of diff.components.removed) {
    const index = added.findIndex((next) => identityMatches(old, next));
    if (index < 0) {
      changes.push({ kind: "removed", fromRef: old.ref, ...details(old), reasons: [] });
      continue;
    }
    const next = added.splice(index, 1)[0]!;
    changes.push({ kind: "renamed", fromRef: old.ref, toRef: next.ref, ...details(next), reasons: ["reference"], ...delta(old, next) });
  }
  for (const next of added) changes.push({ kind: "added", toRef: next.ref, ...details(next), reasons: [] });
  for (const change of diff.components.changed) {
    const reasons = change.reasons.filter((reason) => !reason.startsWith("schematic"));
    if (!reasons.length) continue;
    changes.push({
      kind: reasons.includes("moved") ? "moved" : "changed",
      fromRef: change.ref,
      toRef: change.ref,
      ...details(change.after),
      reasons,
      ...delta(change.before, change.after),
    });
  }
  changes.sort((a, b) => (a.toRef ?? a.fromRef ?? "").localeCompare(b.toRef ?? b.fromRef ?? "", undefined, { numeric: true }));
  const summary = { added: 0, removed: 0, moved: 0, changed: 0, renamed: 0, unchanged: 0 };
  for (const change of changes) summary[change.kind] += 1;
  const matched = summary.moved + summary.changed + summary.renamed;
  summary.unchanged = Math.max(0, to.components.length - summary.added - matched);
  return { from, to, diff, changes, summary };
}

function details(component: ComponentSnapshot) {
  return {
    ...(component.value ? { value: component.value } : {}),
    ...(component.footprint ? { footprint: component.footprint } : {}),
  };
}

function delta(a: ComponentSnapshot, b: ComponentSnapshot) {
  if (a.x === undefined || a.y === undefined || b.x === undefined || b.y === undefined) return {};
  const dx = round(b.x - a.x), dy = round(b.y - a.y);
  return dx || dy ? { dx, dy, distance: round(Math.hypot(dx, dy)) } : {};
}

function drawPart(component: ComponentSnapshot, role: BoardPartRole): string {
  const bounds = boardPartBounds(component);
  if (!bounds) return "";
  const color = ROLE_COLORS[role];
  const padding = 0.25;
  const width = bounds.maxX - bounds.minX + padding * 2, height = bounds.maxY - bounds.minY + padding * 2;
  const pads = (component.pads ?? []).map((pad) => {
    if (pad.x === undefined || pad.y === undefined) return "";
    const center = padWorldPoint(component, pad.x, pad.y);
    const w = pad.width ?? 0.5, h = pad.height ?? 0.5;
    const radius = pad.shape === "circle" || pad.shape === "oval" ? Math.min(w, h) / 2 : pad.shape === "roundrect" ? Math.min(w, h) / 4 : 0;
    const rotate = pad.angle ? ` transform="rotate(${-pad.angle} ${center.x} ${center.y})"` : "";
    return `<rect class="bp-pad" data-pin="${escapeXml(pad.pin)}" x="${round(center.x - w / 2)}" y="${round(center.y - h / 2)}" width="${w}" height="${h}" rx="${round(radius)}" fill="${color}"${rotate}/><text class="bp-pin" display="none" x="${center.x}" y="${round(center.y + Math.min(w, h) * 0.2)}" text-anchor="middle" font-size="${round(Math.max(0.25, Math.min(w, h) * 0.55))}" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="700" fill="#ffffff">${escapeXml(pad.pin)}</text>`;
  }).join("");
  const font = Math.max(0.35, Math.min(1.1, Math.min(width, height) * 0.45));
  return `<g data-ref="${escapeXml(component.ref)}" data-role="${role}" class="bp-part"><rect class="bp-body" x="${round(bounds.minX - padding)}" y="${round(bounds.minY - padding)}" width="${round(width)}" height="${round(height)}" rx="0.15" fill="${color}" fill-opacity="${role === "unchanged" ? 0.06 : 0.22}" stroke="${color}" stroke-width="${role === "unchanged" ? 0.06 : 0.14}"/>${pads}<text class="bp-label" x="${round(bounds.minX + (bounds.maxX - bounds.minX) / 2)}" y="${round(bounds.minY + (bounds.maxY - bounds.minY) / 2 + font * 0.35)}" text-anchor="middle" font-size="${round(font)}" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="600" fill="${role === "unchanged" ? "#334155" : color}">${escapeXml(component.ref)}</text></g>`;
}

function collectBox(snapshot: BoardSnapshot): BoardBox | null {
  const parts = snapshot.components.flatMap((component) => {
    const box = boardPartBounds(component);
    return box ? [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.maxY }] : [];
  });
  return boxOf([...snapshot.outline, ...parts]);
}

function unionBox(boxes: Array<BoardBox | null>): BoardBox {
  const found = boxes.filter((box): box is BoardBox => !!box);
  if (!found.length) return { minX: 0, minY: 0, maxX: 100, maxY: 80 };
  return {
    minX: Math.min(...found.map((box) => box.minX)),
    minY: Math.min(...found.map((box) => box.minY)),
    maxX: Math.max(...found.map((box) => box.maxX)),
    maxY: Math.max(...found.map((box) => box.maxY)),
  };
}

export function boardDrawingSvg(snapshot: BoardSnapshot, opts: {
  box?: BoardBox;
  roles?: ReadonlyMap<string, BoardPartRole>;
  addedCopper?: ReadonlySet<string>;
  removedCopper?: ReadonlySet<string>;
} = {}): string {
  const box = opts.box ?? unionBox([collectBox(snapshot)]);
  const margin = Math.max(2, Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.04);
  const x = box.minX - margin, y = box.minY - margin, width = Math.max(1, box.maxX - box.minX + margin * 2), height = Math.max(1, box.maxY - box.minY + margin * 2);
  const changed = opts.addedCopper ?? opts.removedCopper;
  const changedColor = opts.addedCopper ? ROLE_COLORS.added : ROLE_COLORS.removed;
  const pcbTracks = snapshot.tracks.filter((track) => track.layer !== "schematic");
  const quiet = changed ? pcbTracks.filter((track) => !changed.has(track.id)) : pcbTracks;
  const loud = changed ? pcbTracks.filter((track) => changed.has(track.id)) : [];
  const parts = snapshot.components.map((component) => drawPart(component, opts.roles?.get(component.ref) ?? "unchanged")).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(x)} ${round(y)} ${round(width)} ${round(height)}" data-board-drawing="pcb">
  <rect data-board-background="true" x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="#ffffff"/>
  ${drawZones(snapshot.zones, MUTED_COPPER)}
  ${drawTracks(quiet, "pcb", MUTED_COPPER)}
  ${drawTracks(loud, "pcb", changedColor)}
  ${drawVias(snapshot.vias, MUTED_COPPER)}
  ${drawOutline(snapshot.outline, "#0f172a", snapshot.outlinePaths)}
  ${parts}
</svg>
`;
}

/** Older board on the left, newer on the right, sharing one frame so positions read directly across. */
export function boardPairDrawings(comparison: BoardPairComparison): { from: string; to: string } {
  const { from, to, diff, changes } = comparison;
  const box = unionBox([collectBox(from), collectBox(to)]);
  const fromRoles = new Map<string, BoardPartRole>(), toRoles = new Map<string, BoardPartRole>();
  for (const change of changes) {
    const role: BoardPartRole = change.kind === "renamed" ? "changed" : change.kind;
    if (change.fromRef) fromRoles.set(change.fromRef, role);
    if (change.toRef) toRoles.set(change.toRef, role);
  }
  return {
    from: boardDrawingSvg(from, { box, roles: fromRoles, removedCopper: new Set(diff.tracks.removed.map((track) => track.id)) }),
    to: boardDrawingSvg(to, { box, roles: toRoles, addedCopper: new Set(diff.tracks.added.map((track) => track.id)) }),
  };
}
