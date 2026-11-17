/** Copper left hanging by an edit. */
import { buildCopperGraph, pruneCopperLeaves, type CopperNode } from "../copper-graph";
import { padCopper, routeCopper, zoneCopper } from "./prune-copper";
import { parseBoard } from "../board";
import { kids, parseSexpr, removeSpans, topLevelSpans, type Span } from "../sexpr";

/** Prune only the edited nets; leave unrelated partial routes alone. */
export function pruneDangling(text: string, only?: Set<string>): { text: string; pruned: number } {
  const board = parseBoard(text);
  const stack = board.copperLayers.length ? board.copperLayers : ["F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu"];
  const names = new Map(kids(parseSexpr(text), "net").map(n => [String(n[1]), String(n.at(-1))]));
  const netName = (net: string) => names.get(net) ?? net;
  const nodes: CopperNode<string>[] = [];
  const spans = new Map<string, Span>();
  for (const kind of ["segment", "via", "arc"] as const) for (const span of topLevelSpans(text, kind)) {
    const item = parseSexpr(text.slice(span.start, span.end));
    const copper = routeCopper(item, stack);
    copper.net = netName(copper.net);
    if (only && !only.has(copper.net)) continue;
    const id = `route:${span.start}`;
    nodes.push({ id, net: copper.net, kind: kind === "segment" ? "track" : kind, copper: [copper] });
    spans.set(id, span);
  }
  for (const [i, copper] of padCopper(text, stack).entries()) nodes.push({ id: `pad:${i}`, net: netName(copper.net), kind: "pad", copper: [copper] });
  for (const [i, copper] of zoneCopper(text).entries()) nodes.push({ id: `zone:${i}`, net: copper.net, kind: "zone", copper: [copper] });
  const removed = pruneCopperLeaves(buildCopperGraph(nodes, .000001));
  const drop = [...removed].flatMap(id => spans.has(id) ? [spans.get(id)!] : []);
  return { text: removeSpans(text, drop), pruned: drop.length };
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
