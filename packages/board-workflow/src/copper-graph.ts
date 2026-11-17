/** Shape-aware junction graph shared by both destructive copper cleanup paths. */
import { copperContact, type CopperShape } from "./copper-contact";

export type CopperNode<L> = {
  id: string;
  net: string;
  /** Support is unverified zone geometry: it anchors contacts but never conducts. */
  kind: "track" | "arc" | "via" | "pad" | "zone" | "support";
  copper: Array<{ shape: CopperShape; layers: readonly L[] }>;
};
type Port<L> = { owner: string; copper: CopperNode<L>["copper"] };
export type CopperGraph<L> = {
  nodes: Map<string, CopperNode<L>>;
  /** Outer contacts for retention and candidate propagation. */
  edges: Map<string, Set<string>>;
  sureEdges: Map<string, Set<string>>;
  ports: Port<L>[];
  contacts: Array<[number, number]>;
  ends: Map<string, number[]>;
  incidence: Array<Set<string>>;
  coverage: Map<string, Set<number>[]>;
};
const terminal = <L>(n: CopperNode<L>) => n.kind === "pad" || n.kind === "zone";
const anchor = <L>(n: CopperNode<L>) => terminal(n) || n.kind === "support";

export function buildCopperGraph<L>(allItems: CopperNode<L>[], tolerance = 0): CopperGraph<L> {
  const nodes = new Map(allItems.map(n => [n.id, n]));
  const edges = new Map(allItems.map(n => [n.id, new Set<string>()]));
  const sureEdges = new Map(allItems.map(n => [n.id, new Set<string>()]));
  const items = allItems.filter(n => n.kind !== "support");
  const supports = allItems.filter(n => n.kind === "support");
  const touches = (a: CopperNode<L>["copper"], b: CopperNode<L>["copper"], sure = false) => a.some(x => b.some(y =>
    x.layers.some(layer => copperContact(x.shape, x.layers, y.shape, y.layers, layer, tolerance)[sure ? "surelyTouches" : "mayTouch"])));
  const ports: Port<L>[] = [], contacts: Array<[number, number]> = [], ends = new Map<string, number[]>();
  for (const n of items) {
    const part = n.copper[0];
    const geometry = part?.shape.centerline ?? part?.shape;
    const caps = (n.kind === "track" || n.kind === "arc") && part && geometry && "path" in geometry
      ? [geometry.path[0], geometry.path.at(-1)].flatMap(p => p ? [[{ shape: { path: [p], width: (geometry as {width: number}).width }, layers: part.layers }]] : [])
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
    if (touches(a.copper, b.copper, true)) {
      sureEdges.get(a.id)!.add(b.id); sureEdges.get(b.id)!.add(a.id);
    }
    // Interior/interior crossings have no endpoint region. Record their incidence
    // as an extra junction; both unsplit items continue through it.
    if (!incidence.some(ids => ids.has(a.id) && ids.has(b.id))) {
      ports.push({ owner: a.id, copper: [] }); incidence.push(new Set([a.id, b.id]));
    }
  }
  // Attach support to each touched contact region independently. Giving an
  // outline its own port would union distant contacts through unknown copper.
  // Support has no physical edges, including in terminal-preservation walks.
  for (const support of supports) {
    ports.forEach((port, i) => {
      if (nodes.get(port.owner)!.net === support.net && touches(port.copper, support.copper)) incidence[i]!.add(support.id);
    });
    for (const n of items) {
      if (n.net !== support.net || !touches(n.copper, support.copper)) continue;
      if (!incidence.some(ids => ids.has(n.id) && ids.has(support.id))) {
        ports.push({ owner: n.id, copper: [] }); incidence.push(new Set([n.id, support.id]));
      }
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
    const geometry = part?.shape.centerline ?? part?.shape;
    if (!part || !geometry || !("path" in geometry) || n.kind === "via" || terminal(n)) continue;
    const endPorts = ends.get(n.id)!;
    if (!endPorts.every(i => initialRoot(i) === initialRoot(endPorts[0]!))) continue;
    const { path, width } = geometry;
    const samples = path.flatMap((p, i) => {
      if (!i) return [p];
      const a = path[i - 1]!;
      const steps = Math.max(2, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / Math.max(width / 2, tolerance, 1e-6)));
      return Array.from({ length: steps }, (_, j) => ({ x: a.x + (p.x - a.x) * (j + 1) / steps, y: a.y + (p.y - a.y) * (j + 1) / steps }));
    });
    coverage.set(n.id, samples.map(p => new Set(ports.flatMap((port, i) =>
      nodes.get(port.owner)!.net === n.net && touches([{ shape: { path: [p], width: 0 }, layers: part.layers }], port.copper) ? [i] : []))));
  }
  return { nodes, edges, sureEdges, ports, contacts, ends, incidence, coverage };

}

/** Sequential removals are single-item batches. Rebuild junction unions after each
 * removal: a deleted end cap or via must not keep two surviving regions merged.
 * Verify alternate connectivity using inner copper, including cap-only bridges.
 */
export function pruneCopperLeaves<L>(graph: CopperGraph<L>, seeds?: Iterable<string>): Set<string> {
  const removed = new Set<string>(), candidates = new Set(seeds ?? graph.nodes.keys());
  const preservesTerminals = (id: string) => {
    // A degree-zero/one nonterminal cannot join two surviving items.
    if ([...graph.edges.get(id)!].filter(n => !removed.has(n)).length < 2) return true;
    // Collect every possibly connected terminal before deletion. Starting the
    // after-walk at neighbours could silently lose terminals behind an unknown
    // contact; start at a terminal and require all of them to remain reachable.
    const before = new Set([id]), queue = [id], terminals: string[] = [];
    for (const n of queue) {
      if (terminal(graph.nodes.get(n)!)) terminals.push(n);
      for (const next of graph.edges.get(n)!) if (!removed.has(next) && !before.has(next)) { before.add(next); queue.push(next); }
    }
    if (terminals.length < 2) return true;
    const seen = new Set([terminals[0]!]), after = [terminals[0]!];
    for (const n of after) for (const next of graph.sureEdges.get(n)!) {
      if (next !== id && !removed.has(next) && !seen.has(next)) { seen.add(next); after.push(next); }
    }
    return terminals.every(n => seen.has(n));
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
    const anchored = (ids: Set<string>) => [...ids].some(id => anchor(graph.nodes.get(id)!));
    const absorbed = (id: string, j: number) => endpoints(id).every(e => e === j) &&
      (graph.coverage.get(id) ?? []).every(hits => [...hits].some(i => !removed.has(graph.ports[i]!.owner) && root(i) === j));
    const exits = (j: number, ids: Set<string>, omit: string) => [...ids].reduce((count, id) => {
      const n = graph.nodes.get(id)!;
      if (id === omit || n.kind === "via" || anchor(n)) return count;
      const ends = endpoints(id);
      return count + (absorbed(id, j) ? 0 : ends.every(e => e === j) ? 2 : ends.includes(j) ? 1 : 2);
    }, 0);
    for (const id of candidates) {
      const n = graph.nodes.get(id);
      if (!n || removed.has(id) || anchor(n)) continue;
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
