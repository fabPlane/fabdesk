/** Shape-aware junction graph shared by both destructive copper cleanup paths. */
import { copperShapesTouch, type CopperShape } from "./copper-contact";

export type CopperNode<L> = {
  id: string;
  net: string;
  kind: "track" | "arc" | "via" | "pad" | "zone";
  copper: Array<{ shape: CopperShape; layers: readonly L[] }>;
};
type Port<L> = { owner: string; copper: CopperNode<L>["copper"] };
export type CopperGraph<L> = {
  nodes: Map<string, CopperNode<L>>;
  /** Physical item contacts, retained separately for terminal-connectivity verification. */
  edges: Map<string, Set<string>>;
  ports: Port<L>[];
  contacts: Array<[number, number]>;
  ends: Map<string, number[]>;
  incidence: Array<Set<string>>;
  coverage: Map<string, Set<number>[]>;
};
const terminal = <L>(n: CopperNode<L>) => n.kind === "pad" || n.kind === "zone";

export function buildCopperGraph<L>(items: CopperNode<L>[], tolerance = 0): CopperGraph<L> {
  const nodes = new Map(items.map(n => [n.id, n]));
  const edges = new Map(items.map(n => [n.id, new Set<string>()]));
  const touches = (a: CopperNode<L>["copper"], b: CopperNode<L>["copper"]) => a.some(x => b.some(y =>
    x.layers.some(layer => copperShapesTouch(x.shape, x.layers, y.shape, y.layers, layer, tolerance))));
  const ports: Port<L>[] = [], contacts: Array<[number, number]> = [], ends = new Map<string, number[]>();
  for (const n of items) {
    const part = n.copper[0];
    const caps = (n.kind === "track" || n.kind === "arc") && part && "path" in part.shape
      ? [part.shape.path[0], part.shape.path.at(-1)].flatMap(p => p ? [[{ shape: { path: [p], width: (part.shape as {width: number}).width }, layers: part.layers }]] : [])
      : [n.copper];
    ends.set(n.id, caps.map(copper => { ports.push({ owner: n.id, copper }); return ports.length - 1; }));
  }
  // Merge only contact regions, never the whole length of an unsplit track.
  for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) {
    const a = ports[i]!, b = ports[j]!;
    if (nodes.get(a.owner)!.net === nodes.get(b.owner)!.net && touches(a.copper, b.copper)) contacts.push([i, j]);
  }
  const incidence = ports.map(port => new Set(items.filter(n => n.net === nodes.get(port.owner)!.net && touches(port.copper, n.copper)).map(n => n.id)));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]!, b = items[j]!;
    if (a.net !== b.net || !touches(a.copper, b.copper)) continue;
    edges.get(a.id)!.add(b.id); edges.get(b.id)!.add(a.id);
    // Interior/interior crossings have no endpoint region. Record their incidence
    // as an extra junction; both unsplit items continue through it.
    if (!incidence.some(ids => ids.has(a.id) && ids.has(b.id))) {
      ports.push({ owner: a.id, copper: [] }); incidence.push(new Set([a.id, b.id]));
    }
  }
  // Coincident end junctions can also describe a real loop. Absorb an item
  // only when its centreline stays in that junction's contact regions.
  const initialParents = ports.map((_, i) => i);
  const initialRoot = (i: number): number => { while (initialParents[i] !== i) i = initialParents[i]!; return i; };
  for (const [a, b] of contacts) initialParents[initialRoot(a)] = initialRoot(b);
  const coverage = new Map<string, Set<number>[]>();
  for (const n of items) {
    const part = n.copper[0];
    if (!part || !("path" in part.shape) || n.kind === "via" || terminal(n)) continue;
    const endPorts = ends.get(n.id)!;
    if (!endPorts.every(i => initialRoot(i) === initialRoot(endPorts[0]!))) continue;
    const { path, width } = part.shape;
    const samples = path.flatMap((p, i) => {
      if (!i) return [p];
      const a = path[i - 1]!;
      const steps = Math.max(2, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / Math.max(width / 2, tolerance, 1e-6)));
      return Array.from({ length: steps }, (_, j) => ({ x: a.x + (p.x - a.x) * (j + 1) / steps, y: a.y + (p.y - a.y) * (j + 1) / steps }));
    });
    coverage.set(n.id, samples.map(p => new Set(ports.flatMap((port, i) =>
      nodes.get(port.owner)!.net === n.net && touches([{ shape: { path: [p], width: 0 }, layers: part.layers }], port.copper) ? [i] : []))));
  }
  return { nodes, edges, ports, contacts, ends, incidence, coverage };

}

/** Sequential removals are single-item batches. Rebuild junction unions after each
 * removal: a deleted end cap or via must not keep two surviving regions merged.
 * Independently verify connectivity using full copper, including cap-only bridges.
 */
export function pruneCopperLeaves<L>(graph: CopperGraph<L>, seeds?: Iterable<string>): Set<string> {
  const removed = new Set<string>(), candidates = new Set(seeds ?? graph.nodes.keys());
  const preservesTerminals = (id: string) => {
    const neighbours = [...graph.edges.get(id)!].filter(n => !removed.has(n));
    if (neighbours.length < 2) return true;
    const connected = (omit: boolean) => {
      const seen = new Set<string>(), groups: string[][] = [];
      for (const start of neighbours) {
        if (seen.has(start)) continue;
        const queue = [start], terminals: string[] = []; seen.add(start);
        for (const n of queue) {
          if (terminal(graph.nodes.get(n)!)) terminals.push(n);
          for (const next of graph.edges.get(n)!) if (!removed.has(next) && !(omit && next === id) && !seen.has(next)) { seen.add(next); queue.push(next); }
        }
        groups.push(terminals);
      }
      return groups.filter(g => g.length);
    };
    return connected(true).length <= connected(false).length;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const parent = graph.ports.map((_, i) => i);
    const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
    for (const [a, b] of graph.contacts) if (!removed.has(graph.ports[a]!.owner) && !removed.has(graph.ports[b]!.owner)) parent[root(a)] = root(b);
    const junctions = new Map<number, Set<string>>();
    graph.ports.forEach((port, i) => {
      if (removed.has(port.owner)) return;
      const key = root(i), ids = junctions.get(key) ?? new Set<string>();
      for (const id of graph.incidence[i]!) if (!removed.has(id)) ids.add(id);
      junctions.set(key, ids);
    });
    const endpoints = (id: string) => (graph.ends.get(id) ?? []).map(root);
    const anchored = (ids: Set<string>) => [...ids].some(id => terminal(graph.nodes.get(id)!));
    const absorbed = (id: string, j: number) => endpoints(id).every(e => e === j) &&
      (graph.coverage.get(id) ?? []).every(hits => [...hits].some(i => !removed.has(graph.ports[i]!.owner) && root(i) === j));
    const exits = (j: number, ids: Set<string>, omit: string) => [...ids].reduce((count, id) => {
      const n = graph.nodes.get(id)!;
      if (id === omit || n.kind === "via" || terminal(n)) return count;
      const ends = endpoints(id);
      return count + (absorbed(id, j) ? 0 : ends.every(e => e === j) ? 2 : ends.includes(j) ? 1 : 2);
    }, 0);
    for (const id of candidates) {
      const n = graph.nodes.get(id);
      if (!n || removed.has(id) || terminal(n)) continue;
      const ends = endpoints(id), at = ends[0];
      if (at === undefined) continue;
      let leaf: boolean;
      if (n.kind === "via" || absorbed(id, at)) {
        const ids = junctions.get(at)!;
        leaf = !anchored(ids) && exits(at, ids, id) <= 1;
      } else {
        const interior = [...junctions].some(([j, ids]) => ids.has(id) && !ends.includes(j));
        leaf = !ends.every(e => e === at) && !interior && ends.some(j => {
          const ids = junctions.get(j)!;
          return !anchored(ids) && exits(j, ids, id) === 0 && ![...ids].some(other => graph.nodes.get(other)!.kind === "via");
        });
      }
      if (!leaf || !preservesTerminals(id)) continue;
      removed.add(id); changed = true;
      for (const other of graph.edges.get(id)!) candidates.add(other);
      break; // topology and terminal connectivity are re-evaluated before the next batch
    }
  }
  return removed;
}
