/** Copper left hanging by an edit: dangling tracks and vias, and routes of nets that lost every pad (the toolkit's `route_region`). */
import { pyRound } from "../accept";
import { parseBoard } from "../board";
import { removeSpans, topLevelSpans, type Span } from "../sexpr";

type Pt = [number, number];

/**
 * Repeatedly drop segments with a free end (not on a pad, via or another segment of the net) and vias joined to
 * nothing. `only`: prune just these nets (the ones an edit touched); others keep their partial routes.
 */
export function pruneDangling(text: string, only?: Set<string>): { text: string; pruned: number } {
  const board = parseBoard(text);
  const padAt = new Map<string, Array<[number, number, number]>>();
  for (const p of board.pads) (padAt.get(p.net) ?? padAt.set(p.net, []).get(p.net)!).push([p.x, p.y, Math.max(p.r, 0.15)]);
  const zoneNets = new Set([...text.matchAll(/\(zone\s+\(net "([^"]+)"\)/g)].map((m) => m[1]!));
  let total = 0;
  for (;;) {
    const items: Array<{ kind: string; span: Span; net: string; pts: Pt[] }> = [];
    for (const kind of ["segment", "via", "arc"]) {
      for (const span of topLevelSpans(text, kind)) {
        const it = text.slice(span.start, span.end);
        const net = /\(net "([^"]*)"\)/.exec(it)?.[1] ?? "";
        const pts: Pt[] = [...it.matchAll(/\((?:start|end|at) ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
        items.push({ kind, span, net, pts });
      }
    }
    // Python round(x, 3) (half to even on the binary value), as route_region.prune_dangling keys track ends
    const key = (net: string, x: number, y: number) => `${net}|${pyRound(x, 3).toFixed(3)}|${pyRound(y, 3).toFixed(3)}`;
    const ends = new Map<string, number>();
    for (const it of items) for (const [x, y] of it.pts) ends.set(key(it.net, x, y), (ends.get(key(it.net, x, y)) ?? 0) + 1);
    const segsByNet = new Map<string, Array<[Pt, Pt, number, number]>>();
    for (const it of items) {
      if (it.kind !== "via" && it.pts.length >= 2) {
        const w = /\(width ([-\d.]+)\)/.exec(text.slice(it.span.start, it.span.end));
        (segsByNet.get(it.net) ?? segsByNet.set(it.net, []).get(it.net)!).push([it.pts[0]!, it.pts[it.pts.length - 1]!, w ? Number(w[1]) : 0.15, it.span.start]);
      }
    }
    const onPad = (net: string, x: number, y: number, own?: number, interiorOnly = false): boolean => {
      for (const [px, py, r] of padAt.get(net) ?? []) if ((x - px) ** 2 + (y - py) ** 2 <= r * r) return true;
      for (const [[ax, ay], [bx, by], w, s] of segsByNet.get(net) ?? []) {
        if (s === own) continue;
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2));
        if (interiorOnly && (u <= 0 || u >= 1)) continue;
        if ((x - ax - u * (bx - ax)) ** 2 + (y - ay - u * (by - ay)) ** 2 <= (w / 2) ** 2) return true;
      }
      return false;
    };
    const drop: Span[] = [];
    for (const it of items) {
      if (zoneNets.has(it.net) || (only && !only.has(it.net))) continue;
      if (it.kind === "via") {
        const [x, y] = it.pts[0]!;
        // the via counts itself: itself + one segment = a dead end
        if ((ends.get(key(it.net, x, y)) ?? 0) <= 2 && !onPad(it.net, x, y, undefined, true)) drop.push(it.span);
      } else {
        for (const [x, y] of [it.pts[0]!, it.pts[it.pts.length - 1]!]) {
          if ((ends.get(key(it.net, x, y)) ?? 0) <= 1 && !onPad(it.net, x, y, it.span.start)) {
            drop.push(it.span);
            break;
          }
        }
      }
    }
    if (!drop.length) return { text, pruned: total };
    text = removeSpans(text, drop);
    total += drop.length;
  }
}

/** Delete every item of the given nets that has no pad left on the board (the old net of a re-netted pad). */
export function deletePadless(text: string, nets: Iterable<string>): { text: string; deleted: number; nets: string[] } {
  const withPads = new Set(parseBoard(text).pads.map((p) => p.net));
  const dead = new Set([...nets].filter((n) => n && !withPads.has(n)));
  if (!dead.size) return { text, deleted: 0, nets: [] };
  const spans: Span[] = [];
  for (const kind of ["segment", "via", "arc"])
    for (const s of topLevelSpans(text, kind)) {
      const m = /\(net (?:\d+ )?"([^"]*)"\)/.exec(text.slice(s.start, s.end));
      if (m && dead.has(m[1]!)) spans.push(s);
    }
  return { text: removeSpans(text, spans), deleted: spans.length, nets: [...dead].sort() };
}
