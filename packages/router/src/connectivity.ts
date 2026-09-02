/**
 * Per-connection completion bookkeeping shared by the adapters.
 *
 * Routers merge SimpleRouteJson connections that belong to one net (they share a pad / port) and
 * emit the merged net's traces under a single connection name, so "does a trace carry this
 * connection's name" is the wrong test: every other member of the net would land in `open` even
 * though its pads are joined. `classifyConnections` instead checks the copper: a connection is
 * complete when all of its `pointsToConnect` end up in one connected component of traces, vias
 * and pads.
 */
import type { RouteRequest, SimplifiedPcbTrace } from "@fabdesk/protocol";

import { srjLayerNames } from "./units";

type Srj = RouteRequest["srj"];
type SrjConnection = Srj["connections"][number];
type SrjObstacle = Srj["obstacles"][number];

/** Aliases that identify one physical position (0.01 mm) on one layer, like the autorouter does. */
function positionAlias(x: number, y: number, layer: string): string {
  return `@${Math.round(x * 100)},${Math.round(y * 100)}:${layer}`;
}

class DisjointSets<K> {
  readonly #parent = new Map<K, K>();

  find(key: K): K {
    let root = key;
    let next = this.#parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = this.#parent.get(root);
    }
    // Path compression.
    let cursor = key;
    while (cursor !== root) {
      const parent = this.#parent.get(cursor)!;
      this.#parent.set(cursor, root);
      cursor = parent;
    }
    return root;
  }

  has(key: K): boolean {
    return this.#parent.has(key);
  }

  add(key: K): void {
    if (!this.#parent.has(key)) {
      this.#parent.set(key, key);
    }
  }

  union(a: K, b: K): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // `a`'s root survives so ids handed out earlier stay valid.
      this.#parent.set(rb, ra);
    }
  }
}

/**
 * Which SimpleRouteJson connections form one net. Mirrors the capacity autorouter's merge rule:
 * connections are one net when they share a name alias (`source_trace_id`), a `pcb_port_id`, a
 * point position, or a pad whose `connectedTo` lists both.
 */
export class NetGroups {
  readonly #sets = new DisjointSets<string>();
  readonly #members = new Map<string, string[]>();
  readonly #names: readonly string[];

  /**
   * @param srj the routed SimpleRouteJson
   * @param names the connections being routed (defaults to all of `srj.connections`), in request
   *   order; `members()` returns names in this order and `representative()` is the first of them.
   */
  constructor(srj: Srj, names?: readonly string[]) {
    const wanted = names === undefined ? undefined : new Set(names);
    const connections = srj.connections.filter((c) => wanted === undefined || wanted.has(c.name));
    this.#names = connections.map((c) => c.name);
    for (const connection of connections) {
      this.#sets.add(connection.name);
      for (const alias of connectionAliases(connection)) {
        this.#sets.union(connection.name, alias);
      }
    }
    for (const obstacle of srj.obstacles) {
      const linked = obstacle.connectedTo ?? [];
      const first = linked[0];
      if (first === undefined) continue;
      for (const alias of linked) {
        this.#sets.union(first, alias);
      }
    }
    for (const name of this.#names) {
      const root = this.#sets.find(name);
      const list = this.#members.get(root);
      if (list === undefined) {
        this.#members.set(root, [name]);
      } else {
        list.push(name);
      }
    }
  }

  /** The routed connection names, in request order. */
  get names(): readonly string[] {
    return this.#names;
  }

  /** Every routed connection in the same net as `alias`, or [] when the alias is unknown. */
  members(alias: string): readonly string[] {
    if (!this.#sets.has(alias)) return [];
    return this.#members.get(this.#sets.find(alias)) ?? [];
  }

  /** The first routed connection of `alias`'s net, or undefined when the alias is unknown. */
  representative(alias: string): string | undefined {
    return this.members(alias)[0];
  }

  /** Whether `alias` names a routed connection, a port, or a pad alias of one. */
  knows(alias: string): boolean {
    return this.#sets.has(alias);
  }

  /**
   * An opaque id shared by every alias of one net (including nets with no routed connection), or
   * undefined when the alias is unknown. Stable for the lifetime of this instance.
   */
  netId(alias: string | undefined): string | undefined {
    if (alias === undefined || !this.#sets.has(alias)) return undefined;
    return this.#sets.find(alias);
  }

  /** Registers an extra alias (e.g. a router's internal name) for the net of `points`. */
  alias(name: string, points: readonly { x: number; y: number; layer: string; pcb_port_id?: string | undefined }[]): void {
    for (const point of points) {
      for (const alias of pointAliases(point)) {
        if (!this.#sets.has(alias)) continue;
        const before = this.#sets.find(alias);
        this.#sets.union(alias, name);
        const after = this.#sets.find(alias);
        if (after !== before) {
          const list = this.#members.get(before);
          this.#members.delete(before);
          if (list !== undefined) this.#members.set(after, list);
        }
        return;
      }
    }
  }
}

function pointAliases(point: { x: number; y: number; layer: string; pcb_port_id?: string | undefined }): string[] {
  const aliases = [positionAlias(point.x, point.y, point.layer)];
  if (point.pcb_port_id !== undefined) aliases.push(point.pcb_port_id);
  return aliases;
}

function connectionAliases(connection: SrjConnection): string[] {
  const aliases: string[] = [];
  if (connection.source_trace_id !== undefined) aliases.push(connection.source_trace_id);
  for (const point of connection.pointsToConnect) {
    aliases.push(...pointAliases(point));
  }
  return aliases;
}

export interface Classification {
  /** Connections whose points are all joined by copper, in request order. */
  complete: string[];
  /** Connections with at least one point left unjoined, in request order. */
  open: string[];
}

/** Copper of net `a` and net `b` may touch: same net, or one of them is not attributed to a net. */
function compatible(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/**
 * Copper nodes: trace corners, via barrels, pads and connection points. Each node belongs to a net
 * (or to none when the router did not say); copper of two different nets never joins, so a trace
 * brushing a foreign pad is left for DRC to report rather than counted as that net's connection.
 */
class CopperGraph {
  readonly #sets = new DisjointSets<number>();
  readonly #cell: number;
  readonly #tolerance: number;
  readonly #points = new Map<string, number[]>();
  readonly #pointAt: { x: number; y: number }[] = [];
  readonly #netOf: (string | undefined)[] = [];
  readonly #layerIndex = new Map<string, number>();
  #nextId = 0;

  constructor(layers: readonly string[], tolerance: number) {
    layers.forEach((layer, i) => this.#layerIndex.set(layer, i));
    this.#tolerance = tolerance;
    this.#cell = tolerance;
  }

  layerIndexOf(layer: string): number {
    let index = this.#layerIndex.get(layer);
    if (index === undefined) {
      index = this.#layerIndex.size;
      this.#layerIndex.set(layer, index);
    }
    return index;
  }

  /**
   * Adds a copper node at (x, y) on `layers`, joined to every compatible node within tolerance on
   * those layers.
   */
  point(x: number, y: number, layers: readonly number[], net: string | undefined): number {
    const id = this.#nextId++;
    this.#sets.add(id);
    this.#pointAt[id] = { x, y };
    this.#netOf[id] = net;
    const cx = Math.floor(x / this.#cell);
    const cy = Math.floor(y / this.#cell);
    for (const layer of layers) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const neighbours = this.#points.get(`${layer}:${cx + dx}:${cy + dy}`);
          if (neighbours === undefined) continue;
          for (const other of neighbours) {
            if (!compatible(net, this.#netOf[other])) continue;
            const p = this.#pointAt[other]!;
            if (Math.hypot(p.x - x, p.y - y) <= this.#tolerance) {
              this.#sets.union(id, other);
            }
          }
        }
      }
      const key = `${layer}:${cx}:${cy}`;
      const bucket = this.#points.get(key);
      if (bucket === undefined) {
        this.#points.set(key, [id]);
      } else {
        bucket.push(id);
      }
    }
    return id;
  }

  /** A node without a position (pads are joined explicitly by containment). */
  node(net: string | undefined): number {
    const id = this.#nextId++;
    this.#sets.add(id);
    this.#netOf[id] = net;
    return id;
  }

  netOf(id: number): string | undefined {
    return this.#netOf[id];
  }

  join(a: number, b: number): void {
    this.#sets.union(a, b);
  }

  connected(a: number, b: number): boolean {
    return this.#sets.find(a) === this.#sets.find(b);
  }
}

interface Pad {
  node: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  layers: Set<number>;
  /** The pad's net id (see `NetGroups.netId`), undefined when unknown. */
  net: string | undefined;
}

class PadIndex {
  readonly #cell: number;
  readonly #buckets = new Map<string, Pad[]>();

  constructor(pads: readonly Pad[]) {
    let largest = 0;
    for (const pad of pads) {
      largest = Math.max(largest, pad.maxX - pad.minX, pad.maxY - pad.minY);
    }
    this.#cell = Math.max(largest, 1e-3);
    for (const pad of pads) {
      for (let cx = Math.floor(pad.minX / this.#cell); cx <= Math.floor(pad.maxX / this.#cell); cx += 1) {
        for (let cy = Math.floor(pad.minY / this.#cell); cy <= Math.floor(pad.maxY / this.#cell); cy += 1) {
          const key = `${cx}:${cy}`;
          const bucket = this.#buckets.get(key);
          if (bucket === undefined) {
            this.#buckets.set(key, [pad]);
          } else {
            bucket.push(pad);
          }
        }
      }
    }
  }

  /** Pads whose (tolerance-expanded) rectangle contains (x, y) on any of `layers`. */
  containing(x: number, y: number, layers: readonly number[]): Pad[] {
    const bucket = this.#buckets.get(`${Math.floor(x / this.#cell)}:${Math.floor(y / this.#cell)}`);
    if (bucket === undefined) return [];
    return bucket.filter(
      (pad) =>
        x >= pad.minX &&
        x <= pad.maxX &&
        y >= pad.minY &&
        y <= pad.maxY &&
        layers.some((layer) => pad.layers.has(layer)),
    );
  }
}

export interface ClassifyOptions {
  /**
   * Distance (mm) within which two copper points on one layer count as touching. Defaults to half
   * the minimum trace width: any two centrelines that close overlap in copper.
   */
  tolerance?: number;
  /** Precomputed net groups for `srj` (built when omitted). */
  groups?: NetGroups;
}

/**
 * Decides, for each of `names` (default: every connection of `srj`), whether the routed `traces`
 * join all of its `pointsToConnect`. Copper is connected through consecutive route points of a
 * trace, through vias across layers, through pads (a point inside a pad rectangle on one of the
 * pad's layers) and wherever two points on the same layer lie within `tolerance` of each other.
 * Copper is attributed to a net through the trace's `connection_name` (unknown names count for
 * any net) and copper of two different nets never joins, so a trace crossing a foreign pad is a
 * short for DRC to report, not a connection. Which name a trace carries is otherwise irrelevant,
 * so connections a router merged into one net are judged by that net's copper.
 */
export function classifyConnections(
  srj: Srj,
  traces: readonly SimplifiedPcbTrace[],
  names?: readonly string[],
  options: ClassifyOptions = {},
): Classification {
  const groups = options.groups ?? new NetGroups(srj, names);
  const tolerance = options.tolerance ?? Math.max(1e-6, srj.minTraceWidth / 2);
  const graph = new CopperGraph(srjLayerNames(srj.layerCount), tolerance);
  const layerSpan = (from: string, to: string): number[] => {
    const a = graph.layerIndexOf(from);
    const b = graph.layerIndexOf(to);
    const span: number[] = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) span.push(i);
    return span;
  };

  const pads: Pad[] = [];
  for (const obstacle of srj.obstacles) {
    const alias = obstacle.connectedTo?.[0];
    if (alias === undefined) continue;
    pads.push(padOf(obstacle, groups.netId(alias), graph, tolerance));
  }
  const padIndex = new PadIndex(pads);
  const joinPads = (node: number, x: number, y: number, layers: readonly number[]): void => {
    const net = graph.netOf(node);
    for (const pad of padIndex.containing(x, y, layers)) {
      if (compatible(net, pad.net)) graph.join(node, pad.node);
    }
  };

  for (const trace of traces) {
    // Traces named after a merged net's internal alias, or by a router the groups do not know,
    // are attributed to no net and may join any copper.
    const net = groups.netId(trace.connection_name);
    let previous: number | undefined;
    for (const point of trace.route) {
      const layers =
        point.route_type === "via"
          ? layerSpan(point.from_layer, point.to_layer)
          : [graph.layerIndexOf(point.layer)];
      const node = graph.point(point.x, point.y, layers, net);
      joinPads(node, point.x, point.y, layers);
      if (previous !== undefined) graph.join(previous, node);
      previous = node;
    }
  }

  const wanted = names === undefined ? undefined : new Set(names);
  const complete: string[] = [];
  const open: string[] = [];
  for (const connection of srj.connections) {
    if (wanted !== undefined && !wanted.has(connection.name)) continue;
    const net = groups.netId(connection.name);
    const nodes = connection.pointsToConnect.map((point) => {
      const layers = [graph.layerIndexOf(point.layer)];
      const node = graph.point(point.x, point.y, layers, net);
      joinPads(node, point.x, point.y, layers);
      return node;
    });
    const first = nodes[0];
    const joined = first === undefined || nodes.every((node) => graph.connected(first, node));
    (joined ? complete : open).push(connection.name);
  }
  return { complete, open };
}

function padOf(obstacle: SrjObstacle, net: string | undefined, graph: CopperGraph, tolerance: number): Pad {
  const hw = obstacle.width / 2 + tolerance;
  const hh = obstacle.height / 2 + tolerance;
  return {
    node: graph.node(net),
    minX: obstacle.center.x - hw,
    maxX: obstacle.center.x + hw,
    minY: obstacle.center.y - hh,
    maxY: obstacle.center.y + hh,
    layers: new Set(obstacle.layers.map((layer) => graph.layerIndexOf(layer))),
    net,
  };
}
