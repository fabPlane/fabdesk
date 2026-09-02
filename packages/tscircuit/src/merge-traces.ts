import type { SimplifiedPcbTrace } from "@fabdesk/protocol";
import { asElements, type Element } from "./types";

const DEFAULT_VIA_OUTER_DIAMETER = 0.6;
const DEFAULT_VIA_HOLE_DIAMETER = 0.3;
const ROUTE_ERROR_TYPES = new Set(["pcb_trace_error", "pcb_autorouting_error"]);

function removeRouting(elements: Element[], sourceTraceIds: Set<string> | null): { kept: Element[]; removedTraceIds: Set<string> } {
  const removedTraceIds = new Set<string>();
  const matchesSource = (el: Element) => sourceTraceIds === null || sourceTraceIds.has(String(el.source_trace_id));
  for (const el of elements) {
    if (el.type === "pcb_trace" && matchesSource(el)) removedTraceIds.add(String(el.pcb_trace_id));
  }
  const kept = elements.filter((el) => {
    if (el.type === "pcb_trace") return !removedTraceIds.has(String(el.pcb_trace_id));
    if (el.type === "pcb_via") {
      if (removedTraceIds.has(String(el.pcb_trace_id))) return false;
      return !(typeof el.source_trace_id === "string" && matchesSource(el));
    }
    if (ROUTE_ERROR_TYPES.has(el.type)) {
      if (sourceTraceIds === null) return false;
      return !(removedTraceIds.has(String(el.pcb_trace_id)) || matchesSource(el));
    }
    return true;
  });
  return { kept, removedTraceIds };
}

function nextIdCounter(elements: Element[], type: string): () => string {
  let max = -1;
  const re = new RegExp(`^${type}_(\\d+)$`);
  for (const el of elements) {
    if (el.type !== type) continue;
    const m = re.exec(String(el[`${type}_id`]));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return () => `${type}_${++max}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * What a routed connection stands for in the source domain. @tscircuit/core names SRJ
 * connections after a `source_trace` for pin-to-pin traces, but after the `source_net` for
 * traces that end in a net selector (`to="net.GND"`), so either element type can be the source.
 */
interface ConnectionSource {
  /** `source_trace_id` or `source_net_id`; stored in `source_trace_id` (core does the same). */
  id: string;
  element: Element;
  /** The net the routed copper belongs to, when it can be determined. */
  net: Element | undefined;
}

function resolveConnectionSources(elements: Element[]): (t: SimplifiedPcbTrace, connectionMap: Record<string, string>) => ConnectionSource | undefined {
  const sourceTraces = new Map<string, Element>();
  const sourceNets = new Map<string, Element>();
  for (const el of elements) {
    if (el.type === "source_trace") sourceTraces.set(String(el.source_trace_id), el);
    else if (el.type === "source_net") sourceNets.set(String(el.source_net_id), el);
  }
  const netOfTrace = (trace: Element): Element | undefined => {
    const key = str(trace.subcircuit_connectivity_map_key);
    const netIds = Array.isArray(trace.connected_source_net_ids) ? trace.connected_source_net_ids : [];
    for (const id of netIds) {
      const net = sourceNets.get(String(id));
      if (net && (!key || net.subcircuit_connectivity_map_key === key)) return net;
    }
    if (!key) return undefined;
    for (const net of sourceNets.values()) if (net.subcircuit_connectivity_map_key === key) return net;
    return undefined;
  };
  const lookup = (id: string | undefined): ConnectionSource | undefined => {
    if (!id) return undefined;
    const trace = sourceTraces.get(id);
    if (trace) return { id, element: trace, net: netOfTrace(trace) };
    const net = sourceNets.get(id);
    if (net) return { id, element: net, net };
    return undefined;
  };
  return (t, connectionMap) => {
    if (!t.connection_name) return undefined;
    return lookup(connectionMap[t.connection_name]) ?? lookup(t.connection_name);
  };
}

/**
 * Replaces the routing for each trace's source (looked up through `connectionMap`) with the
 * router's SimplifiedPcbTrace, emitting circuit-json `pcb_trace` (+ one `pcb_via` per via point).
 * Existing pcb_trace/pcb_via elements for the same source_trace_id and their routing errors are
 * dropped; everything else passes through untouched.
 *
 * Every emitted element carries `source_trace_id` (a `source_trace_id`, or the `source_net_id`
 * for net-selector connections, matching what @tscircuit/core writes) and the net's
 * `subcircuit_connectivity_map_key`, so downstream consumers such as circuit-json-to-kicad can
 * assign a net without having to resolve the source element themselves. Vias additionally get
 * `source_net_id`.
 */
export function mergeTraces(circuitJson: unknown[], traces: SimplifiedPcbTrace[], connectionMap: Record<string, string>): unknown[] {
  const elements = asElements(circuitJson);
  const resolveSource = resolveConnectionSources(elements);
  const targets = new Set<string>();
  for (const t of traces) {
    const source = resolveSource(t, connectionMap);
    if (source) targets.add(source.id);
  }
  const { kept } = removeRouting(elements, targets);
  const nextTraceId = nextIdCounter(kept, "pcb_trace");
  const nextViaId = nextIdCounter(kept, "pcb_via");

  const added: Element[] = [];
  for (const trace of traces) {
    const source = resolveSource(trace, connectionMap);
    const pcbTraceId = nextTraceId();
    const scope = {
      ...(source?.element.subcircuit_id ? { subcircuit_id: source.element.subcircuit_id } : {}),
      ...(source?.element.pcb_group_id ? { pcb_group_id: source.element.pcb_group_id } : {}),
    };
    const connectivityKey = str(source?.net?.subcircuit_connectivity_map_key) ?? str(source?.element.subcircuit_connectivity_map_key);
    const netIdentity = {
      ...(source ? { source_trace_id: source.id } : {}),
      ...(connectivityKey ? { subcircuit_connectivity_map_key: connectivityKey } : {}),
    };
    const sourceNetId = str(source?.net?.source_net_id);
    const route: Record<string, unknown>[] = [];
    for (const point of trace.route) {
      if (point.route_type === "wire") {
        route.push({ route_type: "wire", x: point.x, y: point.y, width: point.width, layer: point.layer });
        continue;
      }
      const extra = point as unknown as Record<string, unknown>;
      const outer = typeof extra.via_diameter === "number" ? extra.via_diameter : DEFAULT_VIA_OUTER_DIAMETER;
      const hole = typeof extra.via_hole_diameter === "number" ? extra.via_hole_diameter : DEFAULT_VIA_HOLE_DIAMETER;
      route.push({
        route_type: "via",
        x: point.x,
        y: point.y,
        from_layer: point.from_layer,
        to_layer: point.to_layer,
        outer_diameter: outer,
        hole_diameter: hole,
      });
      added.push({
        type: "pcb_via",
        pcb_via_id: nextViaId(),
        ...scope,
        x: point.x,
        y: point.y,
        outer_diameter: outer,
        hole_diameter: hole,
        from_layer: point.from_layer,
        to_layer: point.to_layer,
        layers: Array.isArray(extra.layers) ? extra.layers : [point.from_layer, point.to_layer],
        pcb_trace_id: pcbTraceId,
        ...netIdentity,
        ...(sourceNetId ? { source_net_id: sourceNetId } : {}),
      });
    }
    added.push({
      type: "pcb_trace",
      pcb_trace_id: pcbTraceId,
      ...scope,
      ...netIdentity,
      route_thickness_mode: "constant",
      route,
    });
  }
  return [...kept, ...added];
}

/**
 * Removes routing (pcb_trace, their pcb_via, routing errors). With `connections`, only traces whose
 * connection name / source_trace_id matches are removed.
 */
export function unrouteCircuit(circuitJson: unknown[], connections?: string[]): unknown[] {
  const elements = asElements(circuitJson);
  const targets = connections && connections.length ? new Set(connections) : null;
  return removeRouting(elements, targets).kept;
}
