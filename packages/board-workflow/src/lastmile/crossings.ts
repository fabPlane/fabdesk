/**
 * Pin-order check (toolkit tools/crossing_check.py): parts whose connections to one neighbour cross, and the rotation
 * that would untangle them. For every movable part and each neighbour it shares at least `minNets` point-to-point nets
 * with, the straight pad-to-pad lines are drawn and their crossings counted for the part as placed and turned in place
 * by 90, 180 and 270 degrees. Geometry only; it moves nothing.
 */
import type { Board, Pad } from "../board";
import { pyRound } from "../accept";
import type { Pt } from "./geometry";

export interface CrossingRow {
  ref: string;
  neighbour: string;
  nets: number;
  crossings_now: number;
  worst_case: number;
  by_turn: Record<string, number>;
  best_rotation: number;
  crossings_best: number;
  best_faces_neighbour: boolean;
  at: [number, number, number];
  side: string;
  neighbour_fixed: boolean;
}

const orient = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const crosses = (a: Pt, b: Pt, c: Pt, d: Pt) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

export const DEFAULT_FIXED = /_(J|SW)\d|^FIT_/;

export function findCrossings(
  board: Board,
  opts: { ground: string; fixed?: (ref: string) => boolean; refs?: ReadonlySet<string> | null; minNets?: number },
): CrossingRow[] {
  const fixed = opts.fixed ?? ((r: string) => DEFAULT_FIXED.test(r));
  const minNets = opts.minNets ?? 3;
  const byRef = new Map<string, Pad[]>();
  const byNet = new Map<string, Pad[]>();
  for (const p of board.pads) {
    (byRef.get(p.ref) ?? byRef.set(p.ref, []).get(p.ref)!).push(p);
    if (p.net !== opts.ground && !p.net.startsWith("unconnected")) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(p);
  }
  const out: CrossingRow[] = [];
  for (const [ref, f] of board.footprints) {
    if (fixed(ref) || (opts.refs && !opts.refs.has(ref))) continue;
    const shared = new Map<string, Array<[Pad, Pad]>>();
    for (const p of byRef.get(ref) ?? [])
      for (const q of byNet.get(p.net) ?? [])
        if (q.ref !== ref && byNet.get(p.net)!.length <= 3) (shared.get(q.ref) ?? shared.set(q.ref, []).get(q.ref)!).push([p, q]);
    for (const [nb, pairs] of shared) {
      if (new Set(pairs.map(([p]) => p.net)).size < minNets) continue;
      const res: Record<number, number> = {};
      const faces: Record<number, boolean> = {};
      for (const rot of [0, 90, 180, 270]) {
        const c = Math.cos((rot * Math.PI) / 180);
        const s = Math.sin((rot * Math.PI) / 180);
        const lines = pairs.map(([p, q]): [Pt, Pt] => {
          const dx = p.x - f.x;
          const dy = p.y - f.y;
          return [[f.x + dx * c + dy * s, f.y - dx * s + dy * c], [q.x, q.y]];
        });
        let n = 0;
        for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (crosses(lines[i]![0], lines[i]![1], lines[j]![0], lines[j]![1])) n++;
        res[rot] = n;
        const cx = pairs.reduce((t, [, q]) => t + q.x, 0) / pairs.length;
        const cy = pairs.reduce((t, [, q]) => t + q.y, 0) / pairs.length;
        const mean = lines.reduce((t, l) => t + Math.hypot(l[0][0] - cx, l[0][1] - cy), 0) / lines.length;
        faces[rot] = mean < Math.hypot(f.x - cx, f.y - cy);
      }
      let best = 0;
      for (const r of [0, 90, 180, 270]) if (res[r]! < res[best]!) best = r;
      const n = pairs.length;
      if (res[0]! >= 2)
        out.push({
          ref,
          neighbour: nb,
          nets: n,
          crossings_now: res[0]!,
          worst_case: (n * (n - 1)) / 2,
          by_turn: Object.fromEntries([0, 90, 180, 270].map((r) => [String((f.rot + r) % 360), res[r]!])),
          best_rotation: (f.rot + best) % 360,
          crossings_best: res[best]!,
          best_faces_neighbour: faces[best]!,
          at: [pyRound(f.x, 2), pyRound(f.y, 2), f.rot],
          side: f.layer[0]!,
          neighbour_fixed: fixed(nb),
        });
    }
  }
  out.sort((a, b) => -(a.crossings_now - a.crossings_best) * 100 - a.crossings_now - (-(b.crossings_now - b.crossings_best) * 100 - b.crossings_now));
  return out;
}

export function crossingLines(rows: readonly CrossingRow[]): string[] {
  if (!rows.length) return ["no part with crossed point-to-point connections to one neighbour"];
  return rows.map((r) => {
    const gain = r.crossings_now - r.crossings_best;
    const advice = gain
      ? `turn to ${r.best_rotation} deg: ${r.crossings_best}` +
        (r.best_faces_neighbour ? "" : " (but those pads then face away: put the part on the other side of the neighbour's pad row instead)")
      : "no rotation helps: move it to the other side of the neighbour's pads, or to the other board side";
    return `${r.ref.padEnd(12)} <-> ${r.neighbour.padEnd(12)} ${r.nets} nets  crossings ${r.crossings_now} of ${r.worst_case}  by rotation ${JSON.stringify(r.by_turn)}  -> ${advice}`;
  });
}
