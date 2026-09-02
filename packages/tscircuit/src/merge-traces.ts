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

/**
 * Replaces the routing for each trace's source_trace (looked up through `connectionMap`) with the
 * router's SimplifiedPcbTrace, emitting circuit-json `pcb_trace` (+ one `pcb_via` per via point).
 * Existing pcb_trace/pcb_via elements for the same source_trace_id and their routing errors are
 * dropped; everything else passes through untouched.
 */
export function mergeTraces(circuitJson: unknown[], traces: SimplifiedPcbTrace[], connectionMap: Record<string, string>): unknown[] {
  const elements = asElements(circuitJson);
  const resolveSource = (t: SimplifiedPcbTrace): string | undefined => {
    if (t.connection_name && connectionMap[t.connection_name]) return connectionMap[t.connection_name];
    if (t.connection_name && elements.some((el) => el.type === "source_trace" && el.source_trace_id === t.connection_name)) {
      return t.connection_name;
    }
    return undefined;
  };
  const targets = new Set<string>();
  for (const t of traces) {
    const sid = resolveSource(t);
    if (sid) targets.add(sid);
  }
  const { kept } = removeRouting(elements, targets);
  const nextTraceId = nextIdCounter(kept, "pcb_trace");
  const nextViaId = nextIdCounter(kept, "pcb_via");
  const sourceTraces = new Map<string, Element>();
  for (const el of kept) if (el.type === "source_trace") sourceTraces.set(String(el.source_trace_id), el);

  const added: Element[] = [];
  for (const trace of traces) {
    const sourceTraceId = resolveSource(trace);
    const source = sourceTraceId ? sourceTraces.get(sourceTraceId) : undefined;
    const pcbTraceId = nextTraceId();
    const scope = {
      ...(source?.subcircuit_id ? { subcircuit_id: source.subcircuit_id } : {}),
      ...(source?.pcb_group_id ? { pcb_group_id: source.pcb_group_id } : {}),
    };
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
        ...(sourceTraceId ? { source_trace_id: sourceTraceId } : {}),
      });
    }
    added.push({
      type: "pcb_trace",
      pcb_trace_id: pcbTraceId,
      ...scope,
      ...(sourceTraceId ? { source_trace_id: sourceTraceId } : {}),
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
