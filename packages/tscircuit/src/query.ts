import { asElements, type CircuitSelect, type Element } from "./types";

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const round = (v: number | undefined): number | undefined => (v === undefined ? undefined : Math.round(v * 1000) / 1000);
const defined = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));

class Index {
  readonly byType = new Map<string, Element[]>();
  readonly byId = new Map<string, Element>();
  constructor(elements: Element[]) {
    for (const el of elements) {
      const list = this.byType.get(el.type);
      if (list) list.push(el);
      else this.byType.set(el.type, [el]);
      const id = str(el[`${el.type}_id`]);
      if (id) this.byId.set(id, el);
    }
  }
  of(type: string): Element[] {
    return this.byType.get(type) ?? [];
  }
  get(id: unknown): Element | undefined {
    return typeof id === "string" ? this.byId.get(id) : undefined;
  }
}

function componentRows(ix: Index): Row[] {
  const pcbByComponent = new Map<string, Element>();
  for (const pcb of ix.of("pcb_component")) {
    const sid = str(pcb.source_component_id);
    if (sid) pcbByComponent.set(sid, pcb);
  }
  const portCounts = new Map<string, number>();
  for (const port of ix.of("source_port")) {
    const cid = str(port.source_component_id);
    if (cid) portCounts.set(cid, (portCounts.get(cid) ?? 0) + 1);
  }
  return ix.of("source_component").map((c) => {
    const id = str(c.source_component_id) ?? "";
    const pcb = pcbByComponent.get(id);
    return defined({
      id,
      name: str(c.name),
      ftype: str(c.ftype),
      value: str(c.display_value) ?? str(c.value) ?? num(c.resistance) ?? num(c.capacitance) ?? num(c.inductance),
      manufacturerPartNumber: str(c.manufacturer_part_number),
      supplierPartNumbers: c.supplier_part_numbers,
      pins: portCounts.get(id) ?? 0,
      pcbX: round(num(pcb?.center && (pcb.center as Row).x)),
      pcbY: round(num(pcb?.center && (pcb.center as Row).y)),
      layer: str(pcb?.layer),
      width: round(num(pcb?.width)),
      height: round(num(pcb?.height)),
      rotation: round(num(pcb?.rotation)),
    });
  });
}

function netRows(ix: Index): Row[] {
  const tracesByNet = new Map<string, number>();
  for (const t of ix.of("source_trace")) {
    for (const nid of (t.connected_source_net_ids as unknown[] | undefined) ?? []) {
      if (typeof nid === "string") tracesByNet.set(nid, (tracesByNet.get(nid) ?? 0) + 1);
    }
  }
  return ix.of("source_net").map((n) => {
    const id = str(n.source_net_id) ?? "";
    return defined({
      id,
      name: str(n.name),
      isGround: n.is_ground === true ? true : undefined,
      isPower: n.is_power === true ? true : undefined,
      traces: tracesByNet.get(id) ?? 0,
    });
  });
}

function portRows(ix: Index): Row[] {
  const pcbByPort = new Map<string, Element>();
  for (const p of ix.of("pcb_port")) {
    const sid = str(p.source_port_id);
    if (sid) pcbByPort.set(sid, p);
  }
  return ix.of("source_port").map((p) => {
    const id = str(p.source_port_id) ?? "";
    const component = ix.get(p.source_component_id);
    const pcb = pcbByPort.get(id);
    return defined({
      id,
      name: str(p.name),
      component: str(component?.name),
      ref: component && p.name ? `${str(component.name)}.${str(p.name)}` : undefined,
      pin: num(p.pin_number),
      hints: Array.isArray(p.port_hints) && p.port_hints.length ? p.port_hints : undefined,
      pcbX: round(num(pcb?.x)),
      pcbY: round(num(pcb?.y)),
      layers: pcb?.layers,
    });
  });
}

function traceRows(ix: Index): Row[] {
  const pcbTracesBySource = new Map<string, string[]>();
  for (const t of ix.of("pcb_trace")) {
    const sid = str(t.source_trace_id);
    const tid = str(t.pcb_trace_id);
    if (!sid || !tid) continue;
    const list = pcbTracesBySource.get(sid);
    if (list) list.push(tid);
    else pcbTracesBySource.set(sid, [tid]);
  }
  return ix.of("source_trace").map((t) => {
    const id = str(t.source_trace_id) ?? "";
    const ports = ((t.connected_source_port_ids as unknown[] | undefined) ?? []).map((pid) => {
      const port = ix.get(pid);
      const component = ix.get(port?.source_component_id);
      return component && port ? `${str(component.name)}.${str(port.name)}` : String(pid);
    });
    const nets = ((t.connected_source_net_ids as unknown[] | undefined) ?? []).map((nid) => str(ix.get(nid)?.name) ?? String(nid));
    const pcbTraceIds = pcbTracesBySource.get(id);
    return defined({
      id,
      name: str(t.display_name) ?? str(t.name),
      ports,
      nets: nets.length ? nets : undefined,
      routed: pcbTraceIds !== undefined,
      pcbTraceIds,
    });
  });
}

function errorRows(elements: Element[]): Row[] {
  return elements
    .filter((el) => el.type.endsWith("_error") || el.type.endsWith("_warning"))
    .map((el) =>
      defined({
        type: el.type,
        severity: el.type.endsWith("_error") ? "error" : "warning",
        message: str(el.message) ?? str(el.error_type),
        id: str(el[`${el.type}_id`]),
        component: str(el.source_component_id) ?? str(el.pcb_component_id),
        trace: str(el.source_trace_id) ?? str(el.pcb_trace_id),
        x: round(num(el.center && (el.center as Row).x)),
        y: round(num(el.center && (el.center as Row).y)),
      }),
    );
}

const SEARCH_KEYS = ["name", "ref", "component", "nets", "ports", "message", "type", "id", "ftype", "value"];

function matches(row: Row, needle: string): boolean {
  for (const key of SEARCH_KEYS) {
    const v = row[key];
    if (typeof v === "string" && v.toLowerCase().includes(needle)) return true;
    if (Array.isArray(v) && v.some((x) => typeof x === "string" && x.toLowerCase().includes(needle))) return true;
  }
  return false;
}

/** Compact, LLM-friendly rows for one facet of a circuit; never returns raw elements. */
export function queryCircuit(circuitJson: unknown[], select: CircuitSelect, filter?: string): Row[] {
  const elements = asElements(circuitJson);
  const ix = new Index(elements);
  let rows: Row[];
  switch (select) {
    case "components":
      rows = componentRows(ix);
      break;
    case "nets":
      rows = netRows(ix);
      break;
    case "ports":
      rows = portRows(ix);
      break;
    case "traces":
      rows = traceRows(ix);
      break;
    case "errors":
      rows = errorRows(elements);
      break;
  }
  const needle = filter?.trim().toLowerCase();
  return needle ? rows.filter((row) => matches(row, needle)) : rows;
}
