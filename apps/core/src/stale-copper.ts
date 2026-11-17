import { BoardLayer } from "@fp-pcb/proto";
import type {
  PcbShortedCopperItem,
  PcbStaleCopperItem,
  PcbStaleCopperReport,
} from "@fabdesk/tools";

export type CopperPoint = { x: number; y: number };

export type CopperPolygon = {
  outline: CopperPoint[];
  holes?: CopperPoint[][];
};

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

function distance(a: CopperPoint, b: CopperPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointSegmentDistance(p: CopperPoint, a: CopperPoint, b: CopperPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function orientation(a: CopperPoint, b: CopperPoint, c: CopperPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(
  a: CopperPoint,
  b: CopperPoint,
  c: CopperPoint,
  d: CopperPoint,
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  )
    return true;
  return (
    (Math.abs(abC) <= EPSILON_NM && pointSegmentDistance(c, a, b) <= EPSILON_NM) ||
    (Math.abs(abD) <= EPSILON_NM && pointSegmentDistance(d, a, b) <= EPSILON_NM) ||
    (Math.abs(cdA) <= EPSILON_NM && pointSegmentDistance(a, c, d) <= EPSILON_NM) ||
    (Math.abs(cdB) <= EPSILON_NM && pointSegmentDistance(b, c, d) <= EPSILON_NM)
  );
}

function segmentDistance(a: CopperPoint, b: CopperPoint, c: CopperPoint, d: CopperPoint): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function pointInRing(point: CopperPoint, ring: CopperPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (pointSegmentDistance(point, a, b) <= EPSILON_NM) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function ringDistance(point: CopperPoint, ring: CopperPoint[]): number {
  let closest = Infinity;
  for (let i = 0; i < ring.length; i++)
    closest = Math.min(
      closest,
      pointSegmentDistance(point, ring[i]!, ring[(i + 1) % ring.length]!),
    );
  return closest;
}

function pointPolygonDistance(point: CopperPoint, polygon: CopperPolygon): number {
  if (!polygon.outline.length) return Infinity;
  if (!pointInRing(point, polygon.outline)) return ringDistance(point, polygon.outline);
  for (const hole of polygon.holes ?? []) {
    if (pointInRing(point, hole)) return ringDistance(point, hole);
  }
  return 0;
}

function segmentPolygonDistance(a: CopperPoint, b: CopperPoint, polygon: CopperPolygon): number {
  if (pointPolygonDistance(a, polygon) === 0 || pointPolygonDistance(b, polygon) === 0) return 0;
  let closest = Infinity;
  for (const ring of [polygon.outline, ...(polygon.holes ?? [])])
    for (let i = 0; i < ring.length; i++)
      closest = Math.min(closest, segmentDistance(a, b, ring[i]!, ring[(i + 1) % ring.length]!));
  return closest;
}

function routeTouchesShape(route: CopperRoute, polygon: CopperPolygon): boolean {
  const radius = route.width / 2;
  if (route.path.length === 1) return pointPolygonDistance(route.path[0]!, polygon) <= radius;
  for (let i = 1; i < route.path.length; i++)
    if (segmentPolygonDistance(route.path[i - 1]!, route.path[i]!, polygon) <= radius) return true;
  return false;
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

/** The path is the centreline (arcs arrive tessellated); widths supply the copper extent. */
function routeTouchesVia(route: CopperRoute, via: CopperRoute): boolean {
  if (!route.layers.some((layer) => via.layers.includes(layer))) return false;
  const centre = via.path[0];
  if (!centre) return false;
  const reach = (via.width + route.width) / 2 + EPSILON_NM;
  if (route.path.length === 1) return distance(centre, route.path[0]!) <= reach;
  return route.path.some((point, i) =>
    i > 0 && pointSegmentDistance(centre, route.path[i - 1]!, point) <= reach,
  );
}

/** An interior contact has two exits even when KiCad stores it as one unsplit item. */
function branchesAtVia(route: CopperRoute, via: CopperRoute): number {
  const reach = (via.width + route.width) / 2 + EPSILON_NM;
  return Math.max(1, routeEndpoints(route).filter((point) => distance(point, via.path[0]!) > reach).length);
}

function pointTouchesZone(point: CopperPoint, layer: BoardLayer, zones: CopperZone[]): boolean {
  return zones.some(
    (zone) =>
      zone.layer === layer &&
      zone.polygons.some((polygon) => pointPolygonDistance(point, polygon) === 0),
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
      const vias = routes.filter((candidate) =>
        candidate.kind === "via" && candidate.layers.includes(layer) &&
        candidate.path[0] && distance(candidate.path[0], point) <= (candidate.width + route.width) / 2 + EPSILON_NM,
      );
      // Before crossing a via, inspect its entire copper on every spanned layer.
      // Foreign copper is also a boundary: removing it must not erase a live junction.
      const via = vias[0];
      const connected = via
        ? routes.filter((candidate) => routeTouchesVia(candidate, via))
        : routes.filter((candidate) => candidate.net === route.net && routeAtPoint(candidate, point, layer));
      if (via) {
        if (vias.length > 1 || connected.some((candidate) => candidate.net !== route.net) ||
          connected.filter((candidate) => candidate.kind === "via").length > 1 ||
          connected.filter((candidate) => candidate.kind !== "via")
            .reduce((sum, candidate) => sum + branchesAtVia(candidate, via), 0) > 2) continue;
        if (pads.some((other) => other.parent !== pad.parent && routeTouchesPad(via, other))) continue;
        if (zones.some((zone) => via.layers.includes(zone.layer) &&
          zone.polygons.some((polygon) => routeTouchesShape(via, polygon)))) continue;
      } else {
        // Preserve the existing track-to-track fan-out boundary rules.
        if (connected.length >= 3) continue;
        if (pads.some((other) => other.parent !== pad.parent && other.shapes.some((shape) =>
          shape.layer === layer && pointPolygonDistance(point, shape.polygon) <= route.width / 2,
        ))) continue;
        if (pointTouchesZone(point, layer, zones)) continue;
      }
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
