/**
 * Why connections are open: the foreign copper walling each end of an open connection (toolkit `bench why` ran KRT's
 * net_forensics and TraceMaker's cause classes; this reads the board model, so it names what is within reach, not a
 * router's verdict). One line per stuck end: the nearest foreign copper, nearest first.
 */
import type { Board } from "../board";
import { dist, segDist, type Pt } from "./geometry";
import type { OpenItem } from "./gate";

export interface Wall {
  net: string;
  kind: "track" | "via" | "pad";
  what: string;
  mm: number;
}

export interface OpenWhy {
  net: string;
  end: Pt;
  to: Pt;
  walls: Wall[];
}

export function whyOpen(board: Board, opens: readonly OpenItem[], nets: readonly string[] | null, radius = 1.0): OpenWhy[] {
  const want = nets && nets.length ? new Set(nets) : null;
  const out: OpenWhy[] = [];
  for (const o of opens) {
    if (want && !want.has(o.net)) continue;
    for (const [end, to] of [[o.a, o.b], [o.b, o.a]] as Array<[Pt, Pt]>) {
      const walls: Wall[] = [];
      for (const s of board.segments)
        if (s.net !== o.net) {
          const d = segDist(end, s.a, s.b) - s.w / 2;
          if (d <= radius) walls.push({ net: s.net, kind: "track", what: `${s.layer} w${s.w}`, mm: Math.round(d * 100) / 100 });
        }
      for (const v of board.vias)
        if (v.net !== o.net) {
          const d = dist(end, [v.x, v.y]) - v.size / 2;
          if (d <= radius) walls.push({ net: v.net, kind: "via", what: "via", mm: Math.round(d * 100) / 100 });
        }
      for (const p of board.pads)
        if (p.net !== o.net) {
          const d = dist(end, [p.x, p.y]) - p.r;
          if (d <= radius) walls.push({ net: p.net, kind: "pad", what: `${p.ref}.${p.pad}`, mm: Math.round(d * 100) / 100 });
        }
      walls.sort((a, b) => a.mm - b.mm);
      out.push({ net: o.net, end, to, walls });
    }
  }
  return out;
}

export function whyLines(rows: readonly OpenWhy[]): string[] {
  if (!rows.length) return ["no open nets; name nets to inspect"];
  const lines = rows.flatMap((r) => [
    `${r.net}: end (${r.end[0]}, ${r.end[1]}) -> (${r.to[0]}, ${r.to[1]})`,
    `    wall: ${r.walls.slice(0, 5).map((w) => `${w.net} ${w.kind} ${w.what} ${w.mm} mm`).join("; ") || "nothing within reach"}${r.walls.length > 5 ? ` (+${r.walls.length - 5} more)` : ""}`,
  ]);
  lines.push("hint: walls within about 1 mm of a stuck end -> blockers:1.0 or leg; a pad caged by parts or a keepout -> nudge:REF@X,Y");
  return lines;
}
