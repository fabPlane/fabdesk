/**
 * Repair scope: the connections attached to a set of components. The B2.23.1 runbook derives
 * the repair problem from nine corrected footprints; this answers "which SRJ connections and
 * nets touch U701, U702, ..." from circuit-json alone (source_component -> source_port ->
 * source_trace), so the caller can unroute exactly those and route them with `onlyConnections`.
 */
import { asElements } from "./types";

export interface ComponentScope {
  /** Component references that were found. */
  components: string[];
  /** Requested references with no `source_component`. */
  missing: string[];
  /** `source_trace_id`s (= SRJ connection names for pin-to-pin traces) touching the components. */
  connections: string[];
  /** Net names (source_net.name) those connections belong to. */
  nets: string[];
  /** Nets touching the components that were left out, with the reason. */
  excluded: Array<{ net: string; connection: string; reason: string }>;
  /** Port count per component reference. */
  ports: Record<string, number>;
}

export interface ScopeOptions {
  /**
   * Leave out nets that own a copper pour (ground/power planes). Their copper stays in place as
   * fixed, netted obstacles; re-routing a plane net would rip up the whole board. Default true.
   */
  excludePlaneNets?: boolean;
  /** Explicit net names to leave out (recorded in `excluded`). */
  excludeNets?: readonly string[];
}

export function connectionsForComponents(
  circuitJson: unknown[],
  refs: readonly string[],
  options: ScopeOptions = {},
): ComponentScope {
  const elements = asElements(circuitJson);
  const wanted = new Set(refs);
  const componentIds = new Map<string, string>(); // source_component_id -> name
  for (const el of elements) {
    if (el.type === "source_component" && typeof el.name === "string" && wanted.has(el.name))
      componentIds.set(String(el.source_component_id), el.name);
  }
  const found = new Set(componentIds.values());
  const ports = new Map<string, string>(); // source_port_id -> component name
  const portCount: Record<string, number> = {};
  for (const el of elements) {
    if (el.type !== "source_port") continue;
    const owner = componentIds.get(String(el.source_component_id));
    if (!owner) continue;
    ports.set(String(el.source_port_id), owner);
    portCount[owner] = (portCount[owner] ?? 0) + 1;
  }
  const nets = new Map<string, string>();
  for (const el of elements)
    if (el.type === "source_net")
      nets.set(String(el.source_net_id), String(el.name ?? el.source_net_id));
  const planeNets = new Set<string>();
  if (options.excludePlaneNets ?? true) {
    for (const el of elements) {
      if (el.type !== "pcb_copper_pour") continue;
      const nid = typeof el.source_net_id === "string" ? nets.get(el.source_net_id) : undefined;
      const name = nid ?? (typeof el.net_name === "string" ? el.net_name : undefined);
      if (name) planeNets.add(name);
    }
  }
  const explicit = new Set(options.excludeNets ?? []);
  const connections: string[] = [];
  const netNames = new Set<string>();
  const excluded: ComponentScope["excluded"] = [];
  for (const el of elements) {
    if (el.type !== "source_trace") continue;
    const portIds = Array.isArray(el.connected_source_port_ids)
      ? (el.connected_source_port_ids as unknown[]).map(String)
      : [];
    if (!portIds.some((id) => ports.has(id))) continue;
    const connection = String(el.source_trace_id);
    const names = (
      Array.isArray(el.connected_source_net_ids)
        ? (el.connected_source_net_ids as unknown[]).map(String)
        : []
    )
      .map((nid) => nets.get(nid))
      .filter((n): n is string => n !== undefined);
    const plane = names.find((n) => planeNets.has(n));
    const listed = names.find((n) => explicit.has(n));
    if (plane !== undefined) {
      excluded.push({
        net: plane,
        connection,
        reason: "plane net (owns a copper pour); its copper stays as fixed obstacles",
      });
      continue;
    }
    if (listed !== undefined) {
      excluded.push({ net: listed, connection, reason: "excluded by request" });
      continue;
    }
    connections.push(connection);
    for (const n of names) netNames.add(n);
  }
  return {
    components: [...found].sort(),
    missing: refs.filter((r) => !found.has(r)),
    connections: connections.sort(),
    nets: [...netNames].sort(),
    excluded: excluded.sort((a, b) => a.net.localeCompare(b.net)),
    ports: portCount,
  };
}
