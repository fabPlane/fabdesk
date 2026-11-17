/** One shape-aware connectivity graph for destructive copper cleanup.
 * Coordinates and tolerance must use the same unit. Edges include where they attach
 * to a route: item degree alone mistakes a T's three pairwise contacts for a loop,
 * and cannot distinguish an unsplit interior contact from an endpoint stub.
 */
import { copperShapesTouch, type CopperShape } from "./copper-contact";

export type CopperNode<L> = {
  id: string;
  net: string;
  kind: "track" | "arc" | "via" | "pad" | "zone";
  copper: Array<{ shape: CopperShape; layers: readonly L[] }>;
};
type Attachment = { ends: boolean[]; interior: boolean };
export type CopperGraph<L> = {
  nodes: Map<string, CopperNode<L>>;
  edges: Map<string, Map<string, Attachment>>;
};
const terminal = <L>(n: CopperNode<L>) => n.kind === "pad" || n.kind === "zone";

export function buildCopperGraph<L>(items: CopperNode<L>[], tolerance = 0): CopperGraph<L> {
  const nodes = new Map(items.map(n => [n.id, n]));
  const edges = new Map(items.map(n => [n.id, new Map<string, Attachment>()]));
  const touches = (a: CopperNode<L>["copper"], b: CopperNode<L>["copper"]) => a.some(x => b.some(y =>
    x.layers.some(layer => copperShapesTouch(x.shape, x.layers, y.shape, y.layers, layer, tolerance))));
  const attachment = (a: CopperNode<L>, b: CopperNode<L>): Attachment => {
    const part = a.copper[0];
    if (!part || !("path" in part.shape) || a.kind === "via" || terminal(a)) return { ends: [], interior: false };
    const { path, width } = part.shape;
    const ends = [path[0], path.at(-1)].map(p => !!p && touches([{ shape: { path: [p], width }, layers: part.layers }], b.copper));
    return { ends, interior: !ends.some(Boolean) };
  };
  const byNet = new Map<string, CopperNode<L>[]>();
  for (const n of items) { const group = byNet.get(n.net) ?? []; group.push(n); byNet.set(n.net, group); }
  for (const group of byNet.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i]!, b = group[j]!;
    if (!touches(a.copper, b.copper)) continue;
    edges.get(a.id)!.set(b.id, attachment(a, b));
    edges.get(b.id)!.set(a.id, attachment(b, a));
  }
  return { nodes, edges };
}

/** Iterative leaf removal. Optional seeds restrict cleanup to vacated fan-outs;
 * neighbours become candidates only after a deletion. No geometry is re-inferred
 * during pruning, and neither caller has a separate via or pad support rule.
 */
export function pruneCopperLeaves<L>(graph: CopperGraph<L>, seeds?: Iterable<string>): Set<string> {
  const removed = new Set<string>();
  const queued = new Set(seeds ?? graph.nodes.keys());
  const queue = [...queued];
  const isLeaf = (id: string): boolean => {
    const node = graph.nodes.get(id)!;
    if (terminal(node)) return false;
    const neighbours = [...graph.edges.get(id)!].filter(([other]) => !removed.has(other));
    if (node.kind === "via") {
      if (neighbours.some(([other]) => terminal(graph.nodes.get(other)!))) return false;
      // An unsplit track reached inside its copper provides two exits, even
      // though represented by one item. Connected vias are ordinary neighbours.
      return neighbours.reduce((sum, [other]) => sum + (graph.edges.get(other)!.get(id)!.interior ? 2 : 1), 0) < 2;
    }
    if (neighbours.some(([, at]) => at.interior)) return false;
    return [0, 1].some(end => !neighbours.some(([, at]) => at.ends[end]));
  };
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    queued.delete(id);
    if (removed.has(id) || !graph.nodes.has(id) || !isLeaf(id)) continue;
    removed.add(id);
    for (const other of graph.edges.get(id)!.keys()) if (!removed.has(other) && !queued.has(other)) {
      queued.add(other); queue.push(other);
    }
  }
  return removed;
}
