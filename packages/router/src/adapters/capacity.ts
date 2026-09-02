import {
  AutoroutingPipelineSolver,
  type SimpleRouteJson as CapacitySrj,
  type SimplifiedPcbTrace as CapacityTrace,
} from "@tscircuit/capacity-autorouter";
import type { CinemaShape, RouteRequest, RouteResult, SimplifiedPcbTrace } from "@fabdesk/protocol";

import { NetGroups, classifyConnections } from "../connectivity";
import { FrameEmitter, tracesToShapes } from "../frames";
import { throwIfAborted, type RouteHooks, type RouterAdapter, type RouterProbe } from "../types";
import { CAPACITY_UNITS_PER_MM, srjLayerNames } from "../units";

/** How long the step loop runs before yielding to the event loop (abort checks, worker messages). */
const YIELD_EVERY_MS = 16;

type SolverOptions = NonNullable<ConstructorParameters<typeof AutoroutingPipelineSolver>[1]>;
type HdRoute = NonNullable<AutoroutingPipelineSolver["highDensityRouteSolver"]>["routes"][number];

/** tscircuit's capacity-mesh autorouter, stepped in-process with a deadline and frame capture. */
export class CapacityAutorouterAdapter implements RouterAdapter {
  readonly id = "capacity" as const;

  async probe(): Promise<RouterProbe> {
    let version = "unknown";
    try {
      const pkg = (await import("@tscircuit/capacity-autorouter/package.json")) as {
        default?: { version?: string };
        version?: string;
      };
      version = pkg.default?.version ?? pkg.version ?? version;
    } catch {
      // Version is informational only.
    }
    return {
      id: this.id,
      present: true,
      ready: true,
      version,
      detail: `@tscircuit/capacity-autorouter ${version} (in-process)`,
    };
  }

  async route(request: RouteRequest, hooks: RouteHooks): Promise<RouteResult> {
    throwIfAborted(hooks.signal);
    const started = performance.now();
    const emitter = new FrameEmitter({
      runId: request.runId,
      router: this.id,
      minFrameIntervalMs: request.minFrameIntervalMs,
      post: hooks.onMessage,
    });

    const layers = srjLayerNames(request.srj.layerCount);
    const layerIndex = (name: string): number => Math.max(0, layers.indexOf(name));
    const only =
      request.onlyConnections === undefined ? undefined : new Set(request.onlyConnections);
    const connections = request.srj.connections.filter(
      (c) => only === undefined || only.has(c.name),
    );
    const names = connections.map((c) => c.name);
    const netIndex = new Map(names.map((name, i) => [name, i] as const));
    // Connections sharing a pad are one net; the solver routes them together and names the merged
    // net's point pairs and traces after one of them (or after an internal `<a>__<b>_mstN` alias).
    const groups = new NetGroups(request.srj, names);
    const resolved = new Map<string, number>();
    const netOf = (name: string | undefined): number => {
      if (name === undefined) return -1;
      const direct = netIndex.get(name);
      if (direct !== undefined) return direct;
      const cached = resolved.get(name);
      if (cached !== undefined) return cached;
      if (!groups.knows(name)) {
        const pair = solver.srjWithPointPairs?.connections.find((c) => c.name === name);
        if (pair !== undefined) {
          groups.alias(
            name,
            pair.pointsToConnect.map((p) => ({
              x: p.x,
              y: p.y,
              layer: "layers" in p ? (p.layers[0] ?? "top") : p.layer,
              ...(p.pcb_port_id !== undefined ? { pcb_port_id: p.pcb_port_id } : {}),
            })),
          );
        }
      }
      const representative = groups.representative(name);
      const net = representative === undefined ? -1 : (netIndex.get(representative) ?? -1);
      resolved.set(name, net);
      return net;
    };
    const viaDiameter = numberField(request.srj, "minViaPadDiameter") ?? 0.6;
    const shapeCtx = { layerIndex, netOf, viaDiameter, unitsPerMm: CAPACITY_UNITS_PER_MM };

    // The protocol SRJ is deliberately loose; the solver validates the rest itself. The capacity
    // mesh only knows axis-aligned rectangles: a rotated rectangle (diagonal pre-routed copper)
    // is widened to its bounding box, a polygon (copper pour) cannot be represented at all and
    // is dropped -- both are reported in `detail` rather than silently flattened.
    const approximated = { rotated: 0, polygons: 0 };
    const obstacles: CapacitySrj["obstacles"] = [];
    for (const o of request.srj.obstacles) {
      if (o.type === "polygon" && o.polygon !== undefined && o.polygon.length >= 3) {
        approximated.polygons += 1;
        continue;
      }
      let { width, height } = o;
      if (o.ccwRotationDegrees !== undefined && o.ccwRotationDegrees % 180 !== 0) {
        approximated.rotated += 1;
        const rad = (o.ccwRotationDegrees * Math.PI) / 180;
        const c = Math.abs(Math.cos(rad));
        const s = Math.abs(Math.sin(rad));
        [width, height] = [o.width * c + o.height * s, o.width * s + o.height * c];
      }
      const { ccwRotationDegrees: _r, polygon: _p, obstacleId: _id, ...rest } = o;
      obstacles.push({ ...rest, type: "rect", width, height, connectedTo: o.connectedTo ?? [] } as CapacitySrj["obstacles"][number]);
    }
    const srj = { ...request.srj, obstacles, connections } as unknown as CapacitySrj;
    const solver = new AutoroutingPipelineSolver(srj, (request.settings ?? {}) as SolverOptions);

    const { minX, minY, maxX, maxY } = request.srj.bounds;
    emitter.meta({
      bounds: { x1: minX, y1: minY, x2: maxX, y2: maxY },
      layers,
      unitsPerMm: CAPACITY_UNITS_PER_MM,
    });
    emitter.static(obstacleShapes(request.srj.obstacles, layerIndex, netOf));

    const hdShapes = (routes: readonly HdRoute[]): CinemaShape[] => hdRoutesToShapes(routes, netOf);
    const partial = (): CinemaShape[] => {
      const stitched = solver.highDensityStitchSolver?.mergedHdRoutes;
      if (stitched !== undefined && stitched.length > 0) {
        return hdShapes(stitched);
      }
      return hdShapes(solver.highDensityRouteSolver?.routes ?? []);
    };

    const deadline = started + request.timeoutMs;
    let timedOut = false;
    let phase = "";
    let phaseNo = 0;
    let lastYield = started;
    const stitchedSeen = new Set<string>();
    const announcedConnections = new Set<string>();
    while (!solver.solved && !solver.failed) {
      solver.step();
      const now = performance.now();
      const current = solver.getCurrentPhase();
      if (current !== phase) {
        phase = current;
        phaseNo += 1;
        emitter.frame({ kind: "pass-start", passNo: phaseNo, status: phase }, partial);
      } else {
        // One `connection` frame per SRJ connection, so `done/total` progress adds up even though
        // the solver stitches a merged net under a single (internal) name.
        let announced = false;
        let shapes: CinemaShape[] | undefined;
        for (const route of solver.highDensityStitchSolver?.mergedHdRoutes ?? []) {
          if (stitchedSeen.has(route.connectionName)) continue;
          stitchedSeen.add(route.connectionName);
          const net = netOf(route.connectionName);
          const members = net >= 0 ? groups.members(names[net]!) : [];
          for (const member of members.length > 0 ? members : [route.connectionName]) {
            if (announcedConnections.has(member)) continue;
            announcedConnections.add(member);
            shapes ??= partial();
            emitter.frame({ kind: "connection", netNumber: netOf(member), status: phase }, shapes);
            announced = true;
          }
        }
        if (!announced) {
          emitter.frame({ kind: "attempt", status: phase }, partial);
        }
      }
      if (now >= deadline) {
        timedOut = true;
        break;
      }
      if (now - lastYield >= YIELD_EVERY_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
        throwIfAborted(hooks.signal);
      }
    }
    throwIfAborted(hooks.signal);

    let traces: SimplifiedPcbTrace[] = [];
    let skipped = 0;
    let detail: string | undefined;
    const notes: string[] = [];
    if (approximated.rotated > 0) notes.push(`${approximated.rotated} rotated obstacle(s) widened to their bounding box`);
    if (approximated.polygons > 0) notes.push(`${approximated.polygons} polygon obstacle(s) (copper pours) dropped: not supported by the capacity mesh`);
    if (solver.solved) {
      const converted = convertTraces(solver.getOutputSimplifiedPcbTraces());
      traces = converted.traces;
      skipped = converted.skipped;
      if (skipped > 0) {
        detail = `${skipped} jumper/through-obstacle route element(s) dropped`;
      }
    } else if (timedOut) {
      detail = `timed out after ${request.timeoutMs} ms in phase ${phase}`;
    } else {
      detail = solver.error ?? `solver failed in phase ${phase}`;
    }
    if (notes.length > 0) detail = [detail, ...notes].filter((d) => d !== undefined).join("; ");
    // Judge completion by the copper, not by trace names: a merged net's traces all carry one
    // connection's name while joining every member connection's pads.
    const { complete, open } = classifyConnections(request.srj, traces, names, { groups });

    emitter.frame({ kind: "done" }, solver.solved ? tracesToShapes(traces, shapeCtx) : partial());

    const result: RouteResult = {
      runId: request.runId,
      router: this.id,
      traces,
      complete,
      open,
      timedOut,
      stats: {
        vias: traces.reduce((n, t) => n + t.route.filter((p) => p.route_type === "via").length, 0),
        segments: traces.reduce(
          (n, t) => n + Math.max(0, t.route.filter((p) => p.route_type === "wire").length - 1),
          0,
        ),
        wallMs: performance.now() - started,
        frames: emitter.framesSent,
        framesThrottled: emitter.framesThrottled,
      },
      ...(detail !== undefined ? { detail } : {}),
    };
    emitter.result(result);
    return result;
  }
}

function numberField(srj: RouteRequest["srj"], key: string): number | undefined {
  const value = (srj as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function obstacleShapes(
  obstacles: RouteRequest["srj"]["obstacles"],
  layerIndex: (layer: string) => number,
  netOf: (name: string | undefined) => number,
): CinemaShape[] {
  const shapes: CinemaShape[] = [];
  let id = 1;
  for (const obstacle of obstacles) {
    const owner = obstacle.connectedTo?.[0];
    const net = netOf(owner);
    const k: CinemaShape["k"] = owner === undefined ? "keepout" : "pad";
    const { x, y } = obstacle.center;
    const hw = obstacle.width / 2;
    const hh = obstacle.height / 2;
    for (const layer of obstacle.layers) {
      shapes.push({
        k,
        id: id++,
        layer: layerIndex(layer),
        net,
        pts: [x - hw, y - hh, x + hw, y + hh],
      });
    }
  }
  return shapes;
}

/** High-density routes carry z as a layer index already; split them per layer like traces. */
function hdRoutesToShapes(
  routes: readonly HdRoute[],
  netOf: (name: string | undefined) => number,
): CinemaShape[] {
  const shapes: CinemaShape[] = [];
  let id = 1;
  for (const route of routes) {
    const net = netOf(route.connectionName);
    let pts: number[] = [];
    let z = -1;
    const flush = (): void => {
      if (pts.length >= 4) {
        shapes.push({ k: "trace", id: id++, layer: z, net, pts, w: route.traceThickness });
      }
      pts = [];
    };
    for (const point of route.route) {
      if (point.z !== z) {
        // Keep the corner on both layers so the runs meet at the via.
        const last = pts.length >= 2 ? [pts[pts.length - 2]!, pts[pts.length - 1]!] : undefined;
        flush();
        z = point.z;
        if (last !== undefined) {
          pts.push(...last);
        }
      }
      pts.push(point.x, point.y);
    }
    flush();
    const r = route.viaDiameter / 2;
    for (const via of route.vias) {
      shapes.push({
        k: "via",
        id: id++,
        layer: -1,
        net,
        pts: [via.x - r, via.y - r, via.x + r, via.y + r],
      });
    }
  }
  return shapes;
}

function convertTraces(output: readonly CapacityTrace[]): {
  traces: SimplifiedPcbTrace[];
  skipped: number;
} {
  let skipped = 0;
  const traces: SimplifiedPcbTrace[] = output.map((trace) => ({
    type: "pcb_trace",
    pcb_trace_id: trace.pcb_trace_id,
    connection_name: trace.connection_name,
    route: trace.route.flatMap((el): SimplifiedPcbTrace["route"] => {
      if (el.route_type === "wire") {
        return [{ route_type: "wire", x: el.x, y: el.y, width: el.width, layer: el.layer }];
      }
      if (el.route_type === "via") {
        return [
          { route_type: "via", x: el.x, y: el.y, from_layer: el.from_layer, to_layer: el.to_layer },
        ];
      }
      skipped += 1;
      return [];
    }),
  }));
  return { traces, skipped };
}
