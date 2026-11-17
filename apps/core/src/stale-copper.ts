import { buildCopperGraph, pruneCopperLeaves, type CopperNode } from "@fabdesk/board-workflow/copper-graph";
import { copperShapesTouch, type ContactPoint, type ContactPolygon } from "@fabdesk/board-workflow/copper-contact";
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
  shapes: Array<{ layer: BoardLayer; polygon: CopperPolygon }>;
};

export type CopperRoute = {
  id: string;
  kind: "track" | "arc" | "via";
  net: string;
  layers: BoardLayer[];
  path: CopperPoint[];
  width: number;
  locked: boolean;
};

export type CopperZone = { layer: BoardLayer; polygons: CopperPolygon[] };

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
    copper: [{ shape: route, layers: route.layers }] }));
  for (const pad of input.allPadsAfter) nodes.push({ id: `pad:${pad.id}`, net: pad.net, kind: "pad",
    copper: pad.shapes.map(({ layer, polygon }) => ({ shape: { polygon }, layers: [layer] })) });
  // The native snapshot contains filled polygons without net labels. Retain its
  // conservative zone-contact policy on each route net until the bridge supplies them.
  for (const net of new Set(input.routes.map(route => route.net))) for (const [i, zone] of input.zones.entries()) {
    nodes.push({ id: `zone:${net}:${i}`, net, kind: "zone", copper: zone.polygons.map(polygon => ({ shape: { polygon }, layers: [zone.layer] })) });
  }
  const graph = buildCopperGraph(nodes, .000001);
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
    for (const start of input.routes.filter(
      (route) =>
        route.net === beforePad.net &&
        routeTouchesPad(route, beforePad),
    )) {
      if (routeTouchesPad(start, afterPad)) continue;
      const removed = pruneCopperLeaves(graph, [start.id]);
      for (const route of input.routes.filter(route => removed.has(route.id))) {
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
