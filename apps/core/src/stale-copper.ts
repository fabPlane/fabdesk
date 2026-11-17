import { copperShapesTouch, contactDistance, pointPolygonDistance, type ContactPoint, type ContactPolygon } from "@fabdesk/board-workflow/copper-contact";
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

const EPSILON_NM = 1;
const distance = contactDistance;
function routeTouchesShape(route: CopperRoute, polygon: CopperPolygon): boolean {
  return route.layers.some(layer => copperShapesTouch(route, route.layers, { polygon }, [layer], layer));
}

function routeTouchesPad(route: CopperRoute, pad: CopperPad): boolean {
  return pad.shapes.some(
    ({ layer, polygon }) => route.layers.includes(layer) && routeTouchesShape(route, polygon),
  );
}

function startsAtPadBeforeVia(route: CopperRoute, pad: CopperPad, routes: CopperRoute[]): boolean {
  if (route.kind === "via") return true;
  const padEnds = routeEndpoints(route).filter((point) =>
    pad.shapes.some(
      ({ layer, polygon }) =>
        route.layers.includes(layer) && pointPolygonDistance(point, polygon) <= route.width / 2,
    ),
  );
  // A centreline that crosses a pad without ending there is still directly attached.
  if (!padEnds.length) return true;
  return padEnds.some((point) =>
    route.layers.some(
      (layer) =>
        !routes.some(
          (candidate) =>
            candidate.kind === "via" &&
            candidate.net === route.net &&
            candidate.id !== route.id &&
            routeAtPoint(candidate, point, layer),
        ),
    ),
  );
}

function routeEndpoints(route: CopperRoute): CopperPoint[] {
  if (route.kind === "via") return route.path.slice(0, 1);
  return route.path.length ? [route.path[0]!, route.path.at(-1)!] : [];
}

function routeAtPoint(route: CopperRoute, point: CopperPoint, layer: BoardLayer): boolean {
  return (
    route.layers.includes(layer) &&
    routeEndpoints(route).some((endpoint) => distance(endpoint, point) <= EPSILON_NM)
  );
}

/** An interior contact has two exits even when stored as one unsplit item. */
function branchesAtContact(route: CopperRoute, contact: CopperRoute): number {
  return Math.max(1, routeEndpoints(route).filter(point => !route.layers.some(layer =>
    copperShapesTouch({ path: [point], width: route.width }, [layer], contact, contact.layers, layer, EPSILON_NM),
  )).length);
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

function fanoutChain(
  start: CopperRoute,
  pad: CopperPad,
  routes: CopperRoute[],
  pads: CopperPad[],
  zones: CopperZone[],
): CopperRoute[] {
  if (start.kind === "via") return [start];
  const chain = new Map([[start.id, start]]);
  const queue = routeEndpoints(start)
    .filter(
      (point) =>
        !pad.shapes.some(
          ({ layer, polygon }) =>
            start.layers.includes(layer) && pointPolygonDistance(point, polygon) <= start.width / 2,
        ),
    )
    .map((point) => ({ route: start, point }));
  const visited = new Set<string>();
  while (queue.length) {
    const { route, point } = queue.shift()!;
    for (const layer of route.layers) {
      const key = `${route.id}|${layer}|${point.x}|${point.y}`;
      if (visited.has(key)) continue;
      visited.add(key);
      // Every hop uses its endpoint's copper area; a via expands that area across its span.
      const endpoint: CopperRoute = { ...route, path: [point], layers: [layer] };
      const touches = (candidate: CopperRoute, contact: CopperRoute) => contact.layers.some(l =>
        copperShapesTouch(candidate, candidate.layers, contact, contact.layers, l, EPSILON_NM));
      const vias = routes.filter(candidate => candidate.kind === "via" && touches(candidate, endpoint));
      const via = vias[0];
      const contact = via ?? endpoint;
      const connected = routes.filter(candidate => touches(candidate, contact));
      if (vias.length > 1 || connected.some(candidate => candidate.net !== route.net) ||
        connected.filter(candidate => candidate.kind === "via").length > 1 ||
        connected.filter(candidate => candidate.kind !== "via")
          .reduce((sum, candidate) => sum + branchesAtContact(candidate, contact), 0) > 2) continue;
      if (pads.some(other => other.parent !== pad.parent && routeTouchesPad(contact, other))) continue;
      if (zones.some(zone => contact.layers.includes(zone.layer) &&
        zone.polygons.some(polygon => routeTouchesShape(contact, polygon)))) continue;
      for (const via of vias) chain.set(via.id, via);
      const next = connected.find(
        (candidate) => candidate.id !== route.id && candidate.kind !== "via",
      );
      if (!next || chain.has(next.id)) continue;
      chain.set(next.id, next);
      for (const endpoint of routeEndpoints(next))
        if (via
          ? distance(endpoint, via.path[0]!) > (via.width + next.width) / 2 + EPSILON_NM
          : distance(endpoint, point) > EPSILON_NM) queue.push({ route: next, point: endpoint });
    }
  }
  return [...chain.values()];
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
        routeTouchesPad(route, beforePad) &&
        startsAtPadBeforeVia(route, beforePad, input.routes),
    )) {
      if (routeTouchesPad(start, afterPad)) continue;
      for (const route of fanoutChain(
        start,
        beforePad,
        input.routes,
        input.allPadsBefore,
        input.zones,
      )) {
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
