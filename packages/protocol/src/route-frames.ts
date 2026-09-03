/**
 * Live routing frame protocol.
 *
 * Shapes follow js_autorouter's PCB Layout Cinema (`src/autoroute/cinema-capture.ts`) verbatim so
 * the internal adapter can forward frames untouched; the capacity-autorouter adapter synthesises the
 * same shapes. Coordinates are in `meta.unitsPerMm` units (js_autorouter: board units; capacity: mm).
 */
import { z } from "zod/v4";

export const RouteProgressKind = z.enum(["pass-start", "attempt", "connection", "pair", "done"]);
export type RouteProgressKind = z.infer<typeof RouteProgressKind>;

export const RouteProgressEvent = z.object({
  kind: RouteProgressKind,
  passNo: z.number().int().optional(),
  netNumber: z.number().int().optional(),
  status: z.string().optional(),
  coupled: z.boolean().optional(),
  airline: z
    .object({
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
    })
    .optional(),
});
export type RouteProgressEvent = z.infer<typeof RouteProgressEvent>;

export const CinemaShape = z.object({
  k: z.enum(["trace", "via", "pad", "keepout", "area"]),
  id: z.number(),
  layer: z.number().int(),
  net: z.number().int(),
  /** Trace: centreline corners as [x0,y0,x1,y1,...]. Others: bounding box [x1,y1,x2,y2]. */
  pts: z.array(z.number()),
  /** Trace: full width. Via/pad: ignored. */
  w: z.number().optional(),
});
export type CinemaShape = z.infer<typeof CinemaShape>;

export const RouteMeta = z.object({
  kind: z.literal("meta"),
  runId: z.string(),
  router: z.string(),
  bounds: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
  layers: z.array(z.string()),
  /** Multiply mm by this to get frame units. */
  unitsPerMm: z.number().positive(),
});
export type RouteMeta = z.infer<typeof RouteMeta>;

export const RouteStatic = z.object({
  kind: z.literal("static"),
  runId: z.string(),
  shapes: z.array(CinemaShape),
});
export type RouteStatic = z.infer<typeof RouteStatic>;

export const RouteFrame = z.object({
  kind: z.literal("frame"),
  runId: z.string(),
  seq: z.number().int(),
  event: RouteProgressEvent,
  elapsedMs: z.number(),
  shapes: z.array(CinemaShape),
});
export type RouteFrame = z.infer<typeof RouteFrame>;

export const RouteFrameLine = z.discriminatedUnion("kind", [RouteMeta, RouteStatic, RouteFrame]);
export type RouteFrameLine = z.infer<typeof RouteFrameLine>;

/** tscircuit SimpleRouteJson, the router input contract. Kept loose: the router validates deeply. */
export const SrjPoint = z.object({ x: z.number(), y: z.number() });
export const SrjConnectionPoint = SrjPoint.extend({
  layer: z.string(),
  pcb_port_id: z.string().optional(),
});
export const SrjObstacle = z.object({
  type: z.string(),
  /** Stable id for diagnostics (js_autorouter names refusals and unmatched owners by it). */
  obstacleId: z.string().optional(),
  layers: z.array(z.string()),
  center: SrjPoint,
  width: z.number(),
  height: z.number(),
  /** Rotation of the width x height rectangle about `center` (pre-routed diagonal copper). */
  ccwRotationDegrees: z.number().optional(),
  /** Explicit outline in mm; used verbatim instead of the rectangle (copper pours). */
  polygon: z.array(SrjPoint).optional(),
  connectedTo: z.array(z.string()).optional(),
  /**
   * A pre-placed via with no net yet (tscircuit `<via netIsAssignable />`, e.g. a Viagrid blank's factory
   * vias). Routers that support it change layers only through such vias and never drill new ones.
   */
  netIsAssignable: z.boolean().optional(),
});
export const SrjConnection = z.object({
  name: z.string(),
  pointsToConnect: z.array(SrjConnectionPoint),
  source_trace_id: z.string().optional(),
});
export const SimpleRouteJson = z.looseObject({
  layerCount: z.number().int().positive(),
  /** tscircuit layer names in stack order (`top`, `inner1..N`, `bottom`), when the producer knows them. */
  layerNames: z.array(z.string()).optional(),
  minTraceWidth: z.number().positive(),
  bounds: z.object({ minX: z.number(), maxX: z.number(), minY: z.number(), maxY: z.number() }),
  obstacles: z.array(SrjObstacle),
  connections: z.array(SrjConnection),
});
export type SimpleRouteJson = z.infer<typeof SimpleRouteJson>;

export const RoutePoint = z.discriminatedUnion("route_type", [
  z.object({
    route_type: z.literal("wire"),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    layer: z.string(),
  }),
  z.object({
    route_type: z.literal("via"),
    x: z.number(),
    y: z.number(),
    from_layer: z.string(),
    to_layer: z.string(),
  }),
]);
export const SimplifiedPcbTrace = z.object({
  type: z.literal("pcb_trace"),
  pcb_trace_id: z.string(),
  connection_name: z.string().optional(),
  route: z.array(RoutePoint),
});
export type SimplifiedPcbTrace = z.infer<typeof SimplifiedPcbTrace>;

export const RouterId = z.enum(["capacity", "freerouting"]);
export type RouterId = z.infer<typeof RouterId>;

export const RouteResult = z.object({
  runId: z.string(),
  router: RouterId,
  traces: z.array(SimplifiedPcbTrace),
  complete: z.array(z.string()),
  open: z.array(z.string()),
  timedOut: z.boolean(),
  stats: z.object({
    vias: z.number().int(),
    segments: z.number().int(),
    wallMs: z.number(),
    frames: z.number().int(),
    /** `attempt` frames the adapter's throttle (`minFrameIntervalMs`) suppressed. */
    framesThrottled: z.number().int().optional(),
    /** Vias the router placed on a pre-placed assignable via (see `SrjObstacle.netIsAssignable`). */
    viasOnFixed: z.number().int().optional(),
  }),
  /** Solver preset the adapter chose (`laser-prefab` when the board has assignable vias). */
  preset: z.string().optional(),
  detail: z.string().optional(),
});
export type RouteResult = z.infer<typeof RouteResult>;

export const RouteRequest = z.object({
  runId: z.string(),
  router: RouterId,
  srj: SimpleRouteJson,
  timeoutMs: z.number().int().positive(),
  /** Minimum gap between `attempt` frames. Structural events always land. */
  minFrameIntervalMs: z.number().int().nonnegative().default(33),
  onlyConnections: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type RouteRequest = z.infer<typeof RouteRequest>;

/** Messages the router worker posts back to its host. */
export const RouterWorkerMessage = z.discriminatedUnion("kind", [
  RouteMeta,
  RouteStatic,
  RouteFrame,
  z.object({ kind: z.literal("result"), runId: z.string(), result: RouteResult }),
  z.object({ kind: z.literal("error"), runId: z.string(), message: z.string() }),
]);
export type RouterWorkerMessage = z.infer<typeof RouterWorkerMessage>;
