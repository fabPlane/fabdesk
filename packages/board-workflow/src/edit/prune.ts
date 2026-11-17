/** Copper left hanging by an edit: dangling tracks and vias, and routes of nets that lost every pad (the toolkit's `route_region`). */
import { copperShapesTouch, type CopperShape } from "../copper-contact";
import { padCopper, routeCopper, type LayerCopper } from "./prune-copper";
import { parseBoard } from "../board";
import { parseSexpr, removeSpans, topLevelSpans, type Span } from "../sexpr";

type Pt = [number, number];

/**
 * Repeatedly drop segments with a free end (not on a pad, via or another segment of the net) and vias joined to
 * nothing. `only`: prune just these nets (the ones an edit touched); others keep their partial routes.
 */
export function pruneDangling(text: string, only?: Set<string>): { text: string; pruned: number } {
  const board = parseBoard(text);
  const stack = board.copperLayers.length ? board.copperLayers : ["F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu"];
  const pads = padCopper(text, stack);
  const touches = (a: LayerCopper, b: LayerCopper) => a.net === b.net &&
    a.layers.some(layer => copperShapesTouch(a.shape, a.layers, b.shape, b.layers, layer, .000001));
  const zoneNets = new Set([...text.matchAll(/\(zone\s+\(net "([^"]+)"\)/g)].map((m) => m[1]!));
  let total = 0;
  for (;;) {
    const items: Array<{ kind: string; span: Span; net: string; pts: Pt[]; copper: LayerCopper }> = [];
    for (const kind of ["segment", "via", "arc"]) {
      for (const span of topLevelSpans(text, kind)) {
        const it = text.slice(span.start, span.end);
        const net = /\(net "([^"]*)"\)/.exec(it)?.[1] ?? "";
        const pts: Pt[] = [...it.matchAll(/\((?:start|end|at) ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
        items.push({ kind, span, net, pts, copper: routeCopper(parseSexpr(it), stack) });
      }
    }
    const drop: Span[] = [];
    for (const it of items) {
      if (zoneNets.has(it.net) || (only && !only.has(it.net))) continue;
      if (it.kind === "via") {
        const supportedByPad = pads.some(pad => touches(it.copper, pad));
        const segments = items.filter(other => other.kind !== "via" && touches(it.copper, other.copper));
        // An unsplit live segment has two exits; a sole endpoint stub has only one.
        const branches = segments.reduce((sum, other) => sum + Math.max(1, [other.pts[0]!, other.pts.at(-1)!].filter(([x, y]) => {
          const end: LayerCopper = { ...other.copper, shape: { path: [{ x, y }], width: "width" in other.copper.shape ? other.copper.shape.width : 0 } };
          return !touches(it.copper, end);
        }).length), 0);
        if (!supportedByPad && branches < 2) drop.push(it.span);
      } else {
        for (const [x, y] of [it.pts[0]!, it.pts[it.pts.length - 1]!]) {
          const shape: CopperShape = { path: [{ x, y }], width: "width" in it.copper.shape ? it.copper.shape.width : 0 };
          const end = { ...it.copper, shape };
          // Preserve the pre-existing track-end pad policy; the via deletion rule above
          // requires real pad copper and spanned layers rather than this legacy radius.
          const onLegacyPad = board.pads.some(pad => pad.net === it.net && Math.hypot(x - pad.x, y - pad.y) <= Math.max(pad.r, .15));
          if (!onLegacyPad && !items.some(other => other !== it && touches(end, other.copper))) {
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
