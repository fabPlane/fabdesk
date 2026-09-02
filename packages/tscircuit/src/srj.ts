import { SimpleRouteJson as SimpleRouteJsonSchema, type SimpleRouteJson } from "@fabdesk/protocol";
import { getSimpleRouteJsonFromCircuitJson } from "@tscircuit/core";
import type { AnyCircuitElement } from "circuit-json";
import { asElements, type Element, type ExtractedSrj } from "./types";

export interface ExtractSrjOptions {
  minTraceWidth?: number;
  /** Routing rules carried over from an import (KiCad netclass); all mm. */
  rules?: { clearanceMm?: number; viaDrillMm?: number; viaDiameterMm?: number } | undefined;
  /**
   * How pre-routed copper (`pcb_trace`/`pcb_via` with a `source_trace_id`, `pcb_copper_pour`) enters
   * the routing problem. `obstacles` (default) keeps it as fixed copper owned by its net; `omit`
   * drops it (a diagnostic, not a fair same-input comparison).
   */
  existingCopper?: "obstacles" | "omit";
  /** Copper pours: `polygon` (default, exact outline) or `omit` (diagnostic). */
  copperPours?: "polygon" | "omit";
}

type Obstacle = SimpleRouteJson["obstacles"][number];

/** tscircuit's layer names for a stack of `layerCount` copper layers: top, inner1..N, bottom. */
export function srjLayerNames(layerCount: number): string[] {
  if (layerCount <= 1) return ["top"];
  const names = ["top"];
  for (let i = 1; i <= layerCount - 2; i += 1) names.push(`inner${i}`);
  names.push("bottom");
  return names;
}

/**
 * Builds the router input from circuit-json via @tscircuit/core. The result is validated against
 * the protocol schema but returned unstripped so routers keep the extra hints core emits
 * (zLayers, port selectors, clearances).
 *
 * Pre-routed copper is handled here rather than by core: core refuses diagonal trace segments and
 * ignores copper pours, both of which an imported board is full of. Traces, vias and pours with a
 * net are taken out before core runs and come back as obstacles owned by that net's connection
 * (`connectedTo`), so a router treats them as fixed copper of the net and as walls for everyone
 * else. Diagonal runs become rotated rectangles (`ccwRotationDegrees`), pours polygons; routers
 * that cannot represent those report what they approximated.
 */
export function extractSimpleRouteJson(circuitJson: unknown[], opts: ExtractSrjOptions = {}): ExtractedSrj {
  const t0 = performance.now();
  const existing = opts.existingCopper ?? "obstacles";
  const pours = opts.copperPours ?? "polygon";
  const elements = asElements(circuitJson);
  const copper: Element[] = [];
  const kept: unknown[] = [];
  for (const el of elements) {
    const isRouted = (el.type === "pcb_trace" || el.type === "pcb_via") && typeof el.source_trace_id === "string";
    const isPour = el.type === "pcb_copper_pour";
    if (isRouted || isPour) copper.push(el);
    else kept.push(el);
  }
  const { simpleRouteJson } = getSimpleRouteJsonFromCircuitJson({
    circuitJson: kept as AnyCircuitElement[],
    ...(opts.minTraceWidth !== undefined ? { minTraceWidth: opts.minTraceWidth } : {}),
    ...(opts.rules?.viaDrillMm !== undefined ? { minViaHoleDiameter: opts.rules.viaDrillMm } : {}),
    ...(opts.rules?.viaDiameterMm !== undefined ? { minViaPadDiameter: opts.rules.viaDiameterMm } : {}),
    ...(opts.rules?.clearanceMm !== undefined
      ? { minTraceToPadEdgeClearance: opts.rules.clearanceMm, minPadEdgeToPadEdgeClearance: opts.rules.clearanceMm, minViaEdgeToPadEdgeClearance: opts.rules.clearanceMm }
      : {}),
  });
  const parsed = SimpleRouteJsonSchema.safeParse(simpleRouteJson);
  if (!parsed.success) {
    throw new Error(`SimpleRouteJson from @tscircuit/core does not satisfy the protocol schema: ${parsed.error.message}`);
  }
  const srj = simpleRouteJson as unknown as SimpleRouteJson;
  dedupeConnections(srj);
  const connectionMap: Record<string, string> = {};
  const namesBySource = new Map<string, string[]>();
  for (const connection of srj.connections) {
    const source = connection.source_trace_id ?? connection.name;
    connectionMap[connection.name] = source;
    const list = namesBySource.get(source) ?? [];
    list.push(connection.name);
    namesBySource.set(source, list);
  }
  srj.layerNames = srjLayerNames(srj.layerCount);
  outlineNonRectangular(srj.obstacles);
  ownObstaclesByConnection(srj.obstacles, namesBySource);
  if (opts.rules?.clearanceMm !== undefined) (srj as Record<string, unknown>)["defaultObstacleMargin"] = opts.rules.clearanceMm;

  const stats = { traces: 0, vias: 0, pours: 0, obstacles: 0, unowned: 0 };
  if (existing !== "omit") {
    const layerSet = new Set(srj.layerNames);
    const obstacles: Obstacle[] = [];
    for (const el of copper) {
      const owners = ownersOf(el, namesBySource);
      if (owners.length === 0) stats.unowned += 1;
      if (el.type === "pcb_trace") {
        stats.traces += 1;
        obstacles.push(...traceObstacles(el, owners, layerSet));
      } else if (el.type === "pcb_via") {
        stats.vias += 1;
        const via = viaObstacle(el, owners, srj.layerNames, layerSet);
        if (via) obstacles.push(via);
      } else if (el.type === "pcb_copper_pour") {
        if (pours === "omit") continue;
        stats.pours += 1;
        const pour = pourObstacle(el, owners, layerSet);
        if (pour) obstacles.push(pour);
      }
    }
    stats.obstacles = obstacles.length;
    srj.obstacles.push(...obstacles);
  }
  return { srj, connectionMap, copper: stats, extractMs: performance.now() - t0 };
}

/**
 * core emits one connection per `source_trace` AND one per `source_net` that has ports, so an
 * imported net (one trace listing all its ports plus its net) comes out twice with identical
 * endpoints. Routed as a pair they fight over the same pads; routed selectively the twin becomes
 * foreign copper sitting exactly on the endpoints. Keep the first of each identical endpoint set
 * (the `source_trace_*` one, which is what `mergeTraces`/`unrouteCircuit` key on) and drop the
 * twin's name from every obstacle owner list.
 */
function dedupeConnections(srj: SimpleRouteJson): void {
  const seen = new Map<string, string>();
  const dropped = new Set<string>();
  const kept: SimpleRouteJson["connections"] = [];
  for (const c of srj.connections) {
    const key = c.pointsToConnect
      .map((p) => p.pcb_port_id ?? `${p.x},${p.y},${p.layer}`)
      .sort()
      .join("|");
    const owner = seen.get(key);
    if (owner !== undefined && owner !== c.name) {
      dropped.add(c.name);
      continue;
    }
    seen.set(key, c.name);
    kept.push(c);
  }
  if (dropped.size === 0) return;
  srj.connections = kept;
  for (const o of srj.obstacles) {
    if (o.connectedTo?.some((id) => dropped.has(id))) o.connectedTo = o.connectedTo.filter((id) => !dropped.has(id));
  }
}

/**
 * core lists a pad's owners as every id its connectivity map knows for the net (pad, port,
 * `source_net_*`, sometimes the `source_trace_*`). Routers match `connectedTo` against SRJ
 * connection names and take the first match (js_autorouter) -- a pad whose owners are only
 * `source_net_37` is a foreign keepout to connection `source_trace_37`, and the router refuses
 * its own first leg. Put the connection names first, keep the rest for the capacity merge rule.
 */
function ownObstaclesByConnection(obstacles: Obstacle[], namesBySource: Map<string, string[]>): void {
  for (const o of obstacles) {
    if (!o.connectedTo || o.connectedTo.length === 0) continue;
    const names = new Set<string>();
    for (const id of o.connectedTo) for (const name of namesBySource.get(id) ?? []) names.add(name);
    if (names.size === 0) continue;
    o.connectedTo = [...names, ...o.connectedTo.filter((id) => !names.has(id))];
  }
}

const RECT_TYPES = new Set(["rect", "rectangle", "via", "pad", "smtpad", "hole", "polygon"]);

/**
 * core describes pill pads/holes as `oval` and round ones as `circle` obstacles with only a
 * centre and size. js_autorouter refuses such shapes rather than square them off, so they get
 * an explicit outline here (a stadium / 16-gon of the same extent); rectangular types stay as is.
 */
function outlineNonRectangular(obstacles: Obstacle[]): void {
  for (const o of obstacles) {
    if (o.polygon !== undefined || RECT_TYPES.has(o.type.toLowerCase())) continue;
    const t = o.type.toLowerCase();
    if (t === "circle" || t === "oval" || t === "pill" || t === "stadium") o.polygon = stadium(o.center, o.width, o.height, o.ccwRotationDegrees ?? 0);
    // Anything else keeps its type; the router decides whether it can represent it.
  }
}

/** Outline of a width x height stadium (a circle when width === height), 8 points per cap. */
function stadium(center: { x: number; y: number }, width: number, height: number, rotationDeg: number): Array<{ x: number; y: number }> {
  const r = Math.min(width, height) / 2;
  const horizontal = width >= height;
  const run = (horizontal ? width - height : height - width) / 2;
  const pts: Array<{ x: number; y: number }> = [];
  const caps = 8;
  const arc = (cx: number, cy: number, from: number): void => {
    for (let i = 0; i <= caps; i += 1) {
      const a = from + (Math.PI * i) / caps;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  if (horizontal) {
    arc(run, 0, -Math.PI / 2);
    arc(-run, 0, Math.PI / 2);
  } else {
    arc(0, run, 0);
    arc(0, -run, Math.PI);
  }
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return pts.map((p) => ({ x: center.x + p.x * c - p.y * s, y: center.y + p.x * s + p.y * c }));
}

function ownersOf(el: Element, namesBySource: Map<string, string[]>): string[] {
  const owners = new Set<string>();
  for (const k of ["source_trace_id", "source_net_id"]) {
    const id = el[k];
    if (typeof id !== "string") continue;
    for (const name of namesBySource.get(id) ?? []) owners.add(name);
  }
  return [...owners];
}

function traceObstacles(el: Element, owners: string[], layers: ReadonlySet<string>): Obstacle[] {
  const route = Array.isArray(el.route) ? (el.route as Array<Record<string, unknown>>) : [];
  const id = String(el.pcb_trace_id ?? "");
  const out: Obstacle[] = [];
  let seg = 0;
  for (let i = 0; i + 1 < route.length; i += 1) {
    const a = route[i]!;
    const b = route[i + 1]!;
    if (a["route_type"] !== "wire" || b["route_type"] !== "wire") continue;
    const layer = String(a["layer"] ?? "");
    if (!layers.has(layer)) continue;
    const ax = Number(a["x"]);
    const ay = Number(a["y"]);
    const bx = Number(b["x"]);
    const by = Number(b["y"]);
    const width = Number(a["width"]) || 0.15;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length === 0) continue;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const obstacle: Obstacle = {
      type: "rect",
      obstacleId: `${id}:${seg++}`,
      layers: [layer],
      center: { x: (ax + bx) / 2, y: (ay + by) / 2 },
      // Round caps: extend the run by half a width at both ends so joints stay covered.
      width: length + width,
      height: width,
      connectedTo: owners,
    };
    // Axis-aligned runs stay plain rectangles (every router handles those); only skewed ones rotate.
    const snapped = Math.round(angle / 90) * 90;
    if (Math.abs(angle - snapped) > 1e-6) obstacle.ccwRotationDegrees = angle;
    else if (snapped % 180 !== 0) {
      obstacle.width = width;
      obstacle.height = length + width;
    }
    out.push(obstacle);
  }
  return out;
}

function viaObstacle(el: Element, owners: string[], stack: string[], layers: ReadonlySet<string>): Obstacle | undefined {
  const x = Number(el.x);
  const y = Number(el.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const d = Number(el.outer_diameter) || 0.6;
  let span = Array.isArray(el.layers) ? (el.layers as unknown[]).map(String).filter((l) => layers.has(l)) : [];
  if (span.length === 0 && typeof el.from_layer === "string" && typeof el.to_layer === "string") {
    const from = stack.indexOf(el.from_layer);
    const to = stack.indexOf(el.to_layer);
    if (from >= 0 && to >= 0) span = stack.slice(Math.min(from, to), Math.max(from, to) + 1);
  }
  if (span.length === 0) span = [...stack];
  return {
    type: "via",
    obstacleId: String(el.pcb_via_id ?? ""),
    layers: span,
    center: { x, y },
    width: d,
    height: d,
    connectedTo: owners,
  };
}

function pourObstacle(el: Element, owners: string[], layers: ReadonlySet<string>): Obstacle | undefined {
  const layer = String(el.layer ?? "");
  if (!layers.has(layer)) return undefined;
  const points = Array.isArray(el.points) ? (el.points as Array<{ x: number; y: number }>) : [];
  if (points.length < 3) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    type: "polygon",
    obstacleId: String(el.pcb_copper_pour_id ?? ""),
    layers: [layer],
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width: maxX - minX,
    height: maxY - minY,
    polygon: points.map((p) => ({ x: p.x, y: p.y })),
    connectedTo: owners,
  };
}
