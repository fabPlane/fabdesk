/**
 * A window picture of the board as SVG, drawn from the board model (toolkit tools/board_view.py / board_page.py drew
 * PNG with matplotlib). Board coordinates, y down: outline box, pads (F red, B blue, through-hole grey) at their copper
 * extent, tracks per copper layer at true width (only the `layers` asked for, as `--layers`; In1/In6 are planes and
 * never drawn), vias, part references, and the open connections. With `drc` (a DRC report, as `--drc FILE`) every
 * unconnected item is drawn as the toolkit draws it: a magenta line through its items with a dot at each and the net's
 * short name at the first; Fabdesk also marks each violation's items with a small orange cross titled with its type
 * (the toolkit draws only the unconnected items). Without `drc`, `opens` draws each open as a dashed line with its net.
 * A legend names the layers drawn. Courtyards, true pad shapes and keepout hatching are not drawn.
 */
import { padOnLayer, type Board } from "../board";
import type { OpenItem } from "./gate";

/** A DRC report's items as the view reads them (kicad-cli JSON `unconnected_items` / `violations`, or a DrcRun). */
export interface ViewDrc {
  unconnected: ReadonlyArray<{ items: ReadonlyArray<{ description: string; pos?: { x: number; y: number } }> }>;
  violations?: ReadonlyArray<{ type?: string; rule?: string; items?: ReadonlyArray<{ description: string; pos?: { x: number; y: number } }> }>;
}

const COL: Record<string, string> = { "F.Cu": "#d62728", "In2.Cu": "#ff7f0e", "In3.Cu": "#bcbd22", "In4.Cu": "#2ca02c", "In5.Cu": "#17becf", "B.Cu": "#1f77b4" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface ViewOptions {
  window?: [number, number, number, number];
  side?: "F" | "B" | "both";
  nets?: readonly string[];
  opens?: readonly OpenItem[];
  labels?: boolean;
  title?: string;
  /** Copper layers whose tracks are drawn (default every drawn layer). */
  layers?: readonly string[];
  /** DRC markers: unconnected items (and violations) from a DRC report; replaces `opens`. */
  drc?: ViewDrc;
}

export function renderBoardSvg(board: Board, o: ViewOptions = {}): string {
  const win = o.window ?? (board.outline ? [board.outline.minX, board.outline.minY, board.outline.maxX, board.outline.maxY] : [0, 0, 100, 100]);
  const [X0, Y0, X1, Y1] = win;
  const side = o.side ?? "both";
  const hl = new Set(o.nets ?? []);
  const shown = new Set(o.layers ?? Object.keys(COL));
  const inside = (x: number, y: number, m = 0) => x >= X0 - m && x <= X1 + m && y >= Y0 - m && y <= Y1 + m;
  const onSide = (layer: string) => side === "both" || layer[0] === side;
  const out: string[] = [];
  const px = 1000 / Math.max(X1 - X0, 1e-6);
  const H = Math.round((Y1 - Y0) * px);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r3(X0)} ${r3(Y0)} ${r3(X1 - X0)} ${r3(Y1 - Y0)}" width="1000" height="${H}">`);
  out.push(`<rect x="${r3(X0)}" y="${r3(Y0)}" width="${r3(X1 - X0)}" height="${r3(Y1 - Y0)}" fill="#f7f7f2"/>`);
  if (o.title) out.push(`<title>${esc(o.title)}</title>`);
  const ol = board.outline;
  if (ol) out.push(`<rect x="${r3(ol.minX)}" y="${r3(ol.minY)}" width="${r3(ol.maxX - ol.minX)}" height="${r3(ol.maxY - ol.minY)}" fill="none" stroke="black" stroke-width="0.15"/>`);
  for (const s of board.segments) {
    const c = COL[s.layer];
    if (!c || !shown.has(s.layer) || !onSide(s.layer) || (!inside(s.a[0], s.a[1], 2) && !inside(s.b[0], s.b[1], 2))) continue;
    const on = !hl.size || hl.has(s.net);
    out.push(`<line x1="${r3(s.a[0])}" y1="${r3(s.a[1])}" x2="${r3(s.b[0])}" y2="${r3(s.b[1])}" stroke="${c}" stroke-width="${r3(s.w)}" stroke-linecap="round" opacity="${on ? 0.85 : 0.15}"/>`);
  }
  for (const p of board.pads) {
    if (!inside(p.x, p.y, 2)) continue;
    const through = p.layers.some((l) => l.startsWith("*"));
    const front = padOnLayer(p, "F.Cu");
    const back = padOnLayer(p, "B.Cu");
    if (side === "F" && !front) continue;
    if (side === "B" && !back) continue;
    const c = through ? "#888" : front ? "#d62728" : "#1f77b4";
    out.push(`<circle cx="${r3(p.x)}" cy="${r3(p.y)}" r="${r3(p.r)}" fill="${c}" opacity="${!hl.size || hl.has(p.net) ? 0.7 : 0.2}"/>`);
  }
  for (const v of board.vias) if (inside(v.x, v.y, 2)) out.push(`<circle cx="${r3(v.x)}" cy="${r3(v.y)}" r="${r3(v.size / 2)}" fill="none" stroke="#333" stroke-width="0.08"/>`);
  if (o.labels)
    for (const f of board.footprints.values()) if (onSide(f.layer) && inside(f.x, f.y)) out.push(`<text x="${r3(f.x)}" y="${r3(f.y)}" font-size="0.9" text-anchor="middle" fill="#222">${esc(f.ref)}</text>`);
  if (o.drc) {
    for (const v of o.drc.violations ?? []) {
      const what = esc(v.type ?? v.rule ?? "drc");
      for (const it of v.items ?? []) {
        if (!it.pos || !inside(it.pos.x, it.pos.y, 2)) continue;
        const [x, y, d] = [it.pos.x, it.pos.y, 0.35];
        out.push(`<path class="drc-violation" d="M${r3(x - d)} ${r3(y - d)}L${r3(x + d)} ${r3(y + d)}M${r3(x - d)} ${r3(y + d)}L${r3(x + d)} ${r3(y - d)}" stroke="#ff7f0e" stroke-width="0.12"><title>${what}</title></path>`);
      }
    }
    for (const u of o.drc.unconnected) {
      const pts = u.items.map((i) => [i.pos?.x ?? 0, i.pos?.y ?? 0] as const);
      if (!pts.length || !pts.some(([x, y]) => inside(x, y, 2))) continue;
      out.push(`<polyline class="drc-open" points="${pts.map(([x, y]) => `${r3(x)},${r3(y)}`).join(" ")}" fill="none" stroke="magenta" stroke-width="0.16"/>`);
      for (const [x, y] of pts) out.push(`<circle class="drc-open-end" cx="${r3(x)}" cy="${r3(y)}" r="0.18" fill="magenta"/>`);
      const m = /\[([^\]]+)\]/.exec(u.items[0]!.description);
      const [x0, y0] = pts[0]!;
      if (m && inside(x0, y0)) out.push(`<text class="drc-open-net" x="${r3(x0)}" y="${r3(y0)}" font-size="0.8" fill="purple">${esc(m[1]!.split("::").pop()!)}</text>`);
    }
  } else
    for (const u of o.opens ?? []) {
      if (!inside(u.a[0], u.a[1], 2) && !inside(u.b[0], u.b[1], 2)) continue;
      out.push(`<line x1="${u.a[0]}" y1="${u.a[1]}" x2="${u.b[0]}" y2="${u.b[1]}" stroke="#d0d" stroke-width="0.12" stroke-dasharray="0.4 0.3"/>`);
      out.push(`<text x="${r3((u.a[0] + u.b[0]) / 2)}" y="${r3((u.a[1] + u.b[1]) / 2)}" font-size="0.8" fill="#a0a">${esc(u.net)}</text>`);
    }
  // legend (upper right): the copper layers drawn, and the open marker when there is one
  const legend: Array<[string, string]> = Object.entries(COL).filter(([l]) => shown.has(l));
  if (o.drc || o.opens?.length) legend.push(["open", "magenta"]);
  const fs = Math.max(0.6, (X1 - X0) / 90);
  legend.forEach(([label, c], i) => {
    const y = Y0 + fs * (1.4 + i * 1.3);
    const x = X1 - fs * 7;
    out.push(`<g class="legend"><line x1="${r3(x)}" y1="${r3(y - fs * 0.3)}" x2="${r3(x + fs * 1.5)}" y2="${r3(y - fs * 0.3)}" stroke="${c}" stroke-width="${r3(fs * 0.35)}"/><text x="${r3(x + fs * 2)}" y="${r3(y)}" font-size="${r3(fs)}" fill="#222">${esc(label)}</text></g>`);
  });
  out.push("</svg>");
  return out.join("\n");
}
