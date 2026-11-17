import { buildCopperGraph, pruneCopperLeaves, type CopperNode } from "@fabdesk/board-workflow/copper-graph";
import { copperShapesTouch, type ContactPoint, type ContactPolygon, type CopperGeometry } from "@fabdesk/board-workflow/copper-contact";
import { BoardLayer } from "@fp-pcb/proto";
import type {
  PcbShortedCopperItem,
  PcbStaleCopperItem,
  PcbStaleCopperReport,
} from "@fabdesk/tools";

export type CopperPoint = ContactPoint;
export type CopperPolygon = ContactPolygon;

export type CopperPad = {
  id: string;
  parent: string;
  reference: string;
  number: string;
  net: string;
  shapes: Array<{ layer: BoardLayer; polygon: CopperPolygon; inner?: CopperGeometry | null }>;
};

export type CopperRoute = {
  id: string;
  kind: "track" | "arc" | "via";
  net: string;
  layers: BoardLayer[];
  path: CopperPoint[];
  width: number;
  locked: boolean;
  inner?: CopperGeometry | null;
};

export type CopperZone = { layer: BoardLayer; polygons: CopperPolygon[]; net?: string };

export type StaleCopperAnalysis = {
  reports: Record<string, PcbStaleCopperReport>;
  staleIds: string[];
  affectedNets: string[];
};

function routeTouchesShape(route: CopperRoute, polygon: CopperPolygon): boolean {
  return route.layers.some(layer => copperShapesTouch(route, route.layers, { polygon }, [layer], layer));
}

function routeTouchesPad(route: CopperRoute, pad: CopperPad): boolean {
  return pad.shapes.some(
    ({ layer, polygon }) => route.layers.includes(layer) && routeTouchesShape(route, polygon),
  );
}

function layerName(layer: BoardLayer | undefined): string | undefined {
  if (layer === undefined) return undefined;
  if (layer === BoardLayer.BL_F_Cu) return "F.Cu";
  if (layer === BoardLayer.BL_B_Cu) return "B.Cu";
  if (layer >= BoardLayer.BL_In1_Cu && layer < BoardLayer.BL_B_Cu)
    return `In${layer - BoardLayer.BL_In1_Cu + 1}.Cu`;
  return BoardLayer[layer];
}

function reported(route: CopperRoute, pad: CopperPad): PcbStaleCopperItem {
  const layer = route.kind === "via" ? undefined : layerName(route.layers[0]);
  return {
    id: route.id,
    kind: route.kind,
    net: route.net,
    ...(layer ? { layer } : {}),
    pad: pad.number,
    locked: route.locked,
  };
}

/** Classifies copper invalidated by a footprint transform and returns only removable fan-out ids. */
export function analyzeStaleCopper(input: {
  beforePads: CopperPad[];
  afterPads: CopperPad[];
  allPadsBefore: CopperPad[];
  allPadsAfter: CopperPad[];
  routes: CopperRoute[];
  zones: CopperZone[];
}): StaleCopperAnalysis {
  const afterById = new Map(input.afterPads.map((pad) => [pad.id, pad]));
  const reports: Record<string, PcbStaleCopperReport> = {};
  const staleIds = new Set<string>();
  const allNets = new Set<string>();
  const nodes: CopperNode<BoardLayer>[] = input.routes.map(route => ({ id: route.id, net: route.net, kind: route.kind,
    copper: [{ shape: { ...route, ...((route.kind === "via" || route.kind === "arc") && route.inner === undefined ? { inner: null } : {}) }, layers: route.layers }] }));
  for (const pad of input.allPadsAfter) nodes.push({ id: `pad:${pad.id}`, net: pad.net, kind: "pad",
    copper: pad.shapes.map(({ layer, polygon, inner }) => ({ shape: { polygon, ...(inner !== undefined ? { inner } : {}) }, layers: [layer] })) });
  // Native placement supplies conservative outlines at the post-move revision.
  // Older callers without net labels retain conservative support on every net.
  for (const net of new Set(input.routes.map(route => route.net))) for (const [i, zone] of input.zones.entries()) {
    if (zone.net !== undefined && zone.net !== net) continue;
    for (const [region, polygon] of zone.polygons.entries())
      nodes.push({ id: `zone:${net}:${i}:${region}`, net, kind: "support", copper: [{ shape: { polygon }, layers: [zone.layer] }] });
  }
  const graph = buildCopperGraph(nodes, .000001);
  const startsFor = (beforePad: CopperPad) => {
    const afterPad = afterById.get(beforePad.id);
    return afterPad ? input.routes.filter(route => route.net === beforePad.net &&
      routeTouchesPad(route, beforePad) && !routeTouchesPad(route, afterPad)) : [];
  };
  // Authorize the union in one pruning run, so independent seeds cannot each
  // delete a redundant path while relying on the other path's survival.
  const removed = pruneCopperLeaves(graph, input.beforePads.flatMap(p => startsFor(p).map(r => r.id)));
  for (const beforePad of input.beforePads) {
    const afterPad = afterById.get(beforePad.id);
    if (!afterPad) continue;
    const report = reports[beforePad.reference] ?? {
      stale: [],
      shorted: [],
      staleCount: 0,
      shortedCount: 0,
      nets: [],
    };
    for (const start of startsFor(beforePad)) {
      if (!removed.has(start.id)) continue;
      const reached = new Set([start.id]), queue = [start.id];
      for (const id of queue) for (const other of graph.edges.get(id)!) {
        if (removed.has(other) && !reached.has(other)) { reached.add(other); queue.push(other); }
      }
      for (const route of input.routes.filter(route => reached.has(route.id))) {
        const item = reported(route, beforePad);
        if (!report.stale.some((existing) => existing.id === item.id && existing.pad === item.pad))
          report.stale.push(item);
        staleIds.add(route.id);
        if (route.net) allNets.add(route.net);
      }
    }
    reports[beforePad.reference] = report;
  }
  for (const pad of input.afterPads) {
    const report = reports[pad.reference] ?? {
      stale: [],
      shorted: [],
      staleCount: 0,
      shortedCount: 0,
      nets: [],
    };
    for (const route of input.routes) {
      if (!route.net || !pad.net || route.net === pad.net || !routeTouchesPad(route, pad)) continue;
      const item: PcbShortedCopperItem = { ...reported(route, pad), padNet: pad.net };
      if (!report.shorted.some((existing) => existing.id === item.id && existing.pad === item.pad))
        report.shorted.push(item);
    }
    reports[pad.reference] = report;
  }
  for (const [reference, report] of Object.entries(reports)) {
    const nets = new Set<string>();
    for (const item of report.stale) if (item.net) nets.add(item.net);
    for (const item of report.shorted) {
      if (item.net) nets.add(item.net);
      if (item.padNet) nets.add(item.padNet);
    }
    report.stale.sort((a, b) => a.id.localeCompare(b.id) || a.pad.localeCompare(b.pad));
    report.shorted.sort((a, b) => a.id.localeCompare(b.id) || a.pad.localeCompare(b.pad));
    report.staleCount = new Set(report.stale.map((item) => item.id)).size;
    report.shortedCount = new Set(report.shorted.map((item) => item.id)).size;
    report.nets = [...nets].sort();
    if (!report.stale.length && !report.shorted.length) delete reports[reference];
  }
  return { reports, staleIds: [...staleIds].sort(), affectedNets: [...allNets].sort() };
}
