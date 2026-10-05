/**
 * Live routing frame protocol.
 *
 * Routing runs on the FabPlane PCB bridge (`POST /sessions/:id/route`); the job streams progress,
 * not geometry, so frames carry events and an empty `shapes` list unless a router adds shapes.
 * Coordinates are in `meta.unitsPerMm` units.
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

export const RouterId = z
  .enum(["fab_router", "freerouting", "capacity"])
  .transform((value) => (value === "capacity" ? ("fab_router" as const) : value));
export type RouterId = z.infer<typeof RouterId>;

export const RouteResult = z.object({
  quality: z.object({ text: z.string(), detailPath: z.string() }).optional(),
  runId: z.string(),
  router: RouterId,
  complete: z.array(z.string()),
  open: z.array(z.string()),
  timedOut: z.boolean(),
  state: z
    .enum(["complete", "partial", "blocked", "no-progress", "unavailable", "timeout", "failed"])
    .optional(),
  remainingEndpoints: z
    .array(
      z.object({
        net: z.string(),
        from: z.object({ x: z.number(), y: z.number() }),
        to: z.object({ x: z.number(), y: z.number() }),
      }),
    )
    .optional(),
  obstacles: z.array(z.string()).optional(),
  changedGeometry: z
    .array(
      z.object({
        kind: z.enum(["trace", "via"]),
        id: z.string(),
        layer: z.number(),
        net: z.number(),
        netName: z.string().optional(),
        points: z.array(z.number()),
        width: z.number().optional(),
      }),
    )
    .optional(),
  /** Changed copper on nets outside a selective request, grouped by actual net. */
  outsideScopeChanges: z.array(z.object({
    net: z.string(),
    traces: z.number().int().nonnegative(),
    vias: z.number().int().nonnegative(),
  })).optional(),
  nextActions: z.array(z.string()).optional(),
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

/** Messages the router worker posts back to its host. */
export const RouterWorkerMessage = z.discriminatedUnion("kind", [
  RouteMeta,
  RouteStatic,
  RouteFrame,
  z.object({ kind: z.literal("result"), runId: z.string(), result: RouteResult }),
  z.object({ kind: z.literal("error"), runId: z.string(), message: z.string() }),
]);
export type RouterWorkerMessage = z.infer<typeof RouterWorkerMessage>;
