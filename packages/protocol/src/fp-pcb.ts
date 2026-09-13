/**
 * Wire types for the FabPlane PCB bridge (`@fp-pcb/bridge` on TensorFleet/fab_pcb), mirrored here
 * so `@fabdesk/core` can be a plain HTTP client of it with no fab_pcb workspace package in its
 * tree — the same way `@fabdesk/tools` mirrors its sibling packages. Deliberately loose: fabdesk
 * validates only the fields it reads, so the bridge can grow without a lockstep release.
 *
 * Sources of truth on fab_pcb: `packages/bridge/README.md` (health, sessions) and
 * `packages/compile/src/types.ts` (`Diagnostic`, `CompileResult`, `CompileSource`). The compile
 * job routes (`/sessions/:id/compile`) mirror the route job in
 * `packages/router/src/bridge-job.ts` and land with fab_pcb PR 2; until that merges the `fp-pcb`
 * compiler is a client of a contract, not of a deployment. Keep the two in sync by hand.
 */
import { z } from "zod/v4";

export const FpPcbSession = z.object({
  id: z.string(),
  state: z.string(),
  /** The project or board file the session's `kicad-cli api-server` opened; null for a bare server. */
  path: z.string().nullable().default(null),
});
export type FpPcbSession = z.infer<typeof FpPcbSession>;

export const FpPcbHealth = z.object({
  ok: z.boolean(),
  name: z.string().optional(),
  kicadCli: z.string().optional(),
  kicadCliExists: z.boolean().optional(),
  workspaceRoot: z.string().optional(),
  sessions: z.array(FpPcbSession).default([]),
  compile: z.object({ frontends: z.array(z.string()).default([]) }).optional(),
});
export type FpPcbHealth = z.infer<typeof FpPcbHealth>;

/** `@fp-pcb/compile` `Diagnostic`. `line`/`column` are 1-based; `file` is project-relative. */
export const FpPcbDiagnostic = z.object({
  severity: z.enum(["error", "warning"]),
  stage: z.string(),
  message: z.string(),
  code: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
});
export type FpPcbDiagnostic = z.infer<typeof FpPcbDiagnostic>;

export const FpPcbCompileCounts = z.object({
  components: z.number().default(0),
  nets: z.number().default(0),
  footprintsAdded: z.number().default(0),
  footprintsPlaced: z.number().default(0),
  /** A blank's free vias / cutouts drawn with the outline. */
  viasAdded: z.number().default(0),
  holesAdded: z.number().default(0),
});

export const FpPcbCompileResult = z.object({
  ok: z.boolean(),
  diagnostics: z.array(FpPcbDiagnostic).default([]),
  counts: FpPcbCompileCounts.default({
    components: 0,
    nets: 0,
    viasAdded: 0,
    holesAdded: 0,
    footprintsAdded: 0,
    footprintsPlaced: 0,
  }),
  netlistPath: z.string().optional(),
  durationMs: z.number().default(0),
});
export type FpPcbCompileResult = z.infer<typeof FpPcbCompileResult>;

/** `@fp-pcb/compile` `CompileSource`: the frontend kind plus the project files it reads, inline. */
export const FpPcbCompileSource = z.object({
  kind: z.string(),
  files: z.record(z.string(), z.string()),
  entrypoint: z.string(),
});
export type FpPcbCompileSource = z.infer<typeof FpPcbCompileSource>;

/** Design rules in mm (`@fp-pcb/compile` `BoardRules`): only the fields given change on the board. */
export const FpPcbBoardRules = z.object({
  clearanceMm: z.number().optional(),
  trackWidthMm: z.number().optional(),
  viaDiameterMm: z.number().optional(),
  viaDrillMm: z.number().optional(),
});
export type FpPcbBoardRules = z.infer<typeof FpPcbBoardRules>;

/**
 * Board setup for the compile (`@fp-pcb/compile` `BoardSpec`), mm, outline top-left at the origin
 * with +y down (KiCad's frame). `vias` and `holes` describe a prefabricated blank: free vias the
 * router may claim, and cutouts drawn on `Edge.Cuts`.
 */
export const FpPcbBoardSpec = z.object({
  outline: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  widthMm: z.number().optional(),
  heightMm: z.number().optional(),
  copperLayers: z.number().optional(),
  rules: FpPcbBoardRules.optional(),
  vias: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        diameterMm: z.number().optional(),
        drillMm: z.number().optional(),
      }),
    )
    .optional(),
  holes: z.array(z.object({ x: z.number(), y: z.number(), diameterMm: z.number() })).optional(),
});
export type FpPcbBoardSpec = z.infer<typeof FpPcbBoardSpec>;

/** Body of `POST /sessions/:id/compile`. */
export const FpPcbCompileRequest = z.object({
  source: FpPcbCompileSource,
  /**
   * Where the KiCad project lives on the server's filesystem. Required when the session was
   * created with `path: null` (no project open yet): the job creates it there. Ignored otherwise.
   */
  project: z.object({ path: z.string() }).optional(),
  board: FpPcbBoardSpec.optional(),
  matchMode: z.enum(["reference", "uuid"]).optional(),
  deleteExtraFootprints: z.boolean().optional(),
  updateFootprints: z.boolean().optional(),
  autoplace: z.boolean().optional(),
  /** `SaveDocument` after placing; default true, because everything downstream reads the file. */
  save: z.boolean().optional(),
  netlistPath: z.string().optional(),
  message: z.string().optional(),
});
export type FpPcbCompileRequest = z.infer<typeof FpPcbCompileRequest>;

export const FpPcbCompileJobState = z.enum([
  "queued",
  "frontend",
  "validating",
  "checking",
  "outlining",
  "importing",
  "placing",
  "saving",
  "done",
  "failed",
  "cancelled",
]);
export type FpPcbCompileJobState = z.infer<typeof FpPcbCompileJobState>;

export const FP_PCB_TERMINAL_STATES: ReadonlySet<FpPcbCompileJobState> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export const FpPcbCompileJob = z.object({
  id: z.string(),
  state: FpPcbCompileJobState,
  frontend: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  log: z.array(z.string()).default([]),
  /** Set when the job reached `done` or `failed` through the compiler; absent on infrastructure failure. */
  result: FpPcbCompileResult.optional(),
  /** Infrastructure failure (no KiCad, session gone, ...), as opposed to a compile diagnostic. */
  error: z.string().optional(),
  /** Document revision after the job, so a client can refresh without waiting for an event. */
  revision: z.number().optional(),
});
export type FpPcbCompileJob = z.infer<typeof FpPcbCompileJob>;

/** SSE event names on `GET /sessions/:id/compile/:job` with `Accept: text/event-stream`. */
export const FP_PCB_SSE_EVENTS = {
  state: "state",
  progress: "progress",
  done: "done",
  error: "error",
} as const;

/** `@fp-pcb/router` `RouteProgress`, as the route job streams it; kept loose. */
export const FpPcbRouteProgress = z.looseObject({
  phase: z.string().optional(),
  /** JS router: solver progress within the phase, 0–100. */
  percent: z.number().optional(),
  message: z.string().optional(),
  pass: z.number().optional(),
  routed: z.number().optional(),
  total: z.number().optional(),
});
export type FpPcbRouteProgress = z.infer<typeof FpPcbRouteProgress>;

export const FpPcbRouteJobState = z.enum([
  "queued",
  "saving",
  "filling",
  "extracting",
  "routing",
  "applying",
  "done",
  "failed",
  "cancelled",
]);
export type FpPcbRouteJobState = z.infer<typeof FpPcbRouteJobState>;

export const FpPcbRouteUnrouted = z.object({
  net: z.string(),
  from: z.object({ x: z.number(), y: z.number() }),
  to: z.object({ x: z.number(), y: z.number() }),
});

export const FpPcbRouteSummary = z.object({
  tracks: z.number().default(0),
  /** Vias the router added. */
  vias: z.number().default(0),
  /** Free vias (a blank's) the routing claimed. */
  claimedVias: z.number().default(0),
  /** JS router preset: `default` or `laser-prefab`. */
  preset: z.string().optional(),
  routed: z.number().default(0),
  routerRouted: z.number().default(0),
  total: z.number().default(0),
  trackLengthNm: z.number().default(0),
  elapsedMs: z.number().default(0),
  wallMs: z.number().default(0),
  timedOut: z.boolean().default(false),
  message: z.string().default(""),
  unrouted: z.array(FpPcbRouteUnrouted).default([]),
  log: z.array(z.string()).default([]),
});
export type FpPcbRouteSummary = z.infer<typeof FpPcbRouteSummary>;

/** Body of `POST /sessions/:id/route` (`@fp-pcb/router/bridge-job` `RouteJobRequest`). */
export const FpPcbRouteRequest = z.object({
  router: z.enum(["js", "freerouting"]),
  options: z
    .object({
      nets: z.array(z.string()).optional(),
      maxTimeMs: z.number().optional(),
      layers: z.array(z.number()).optional(),
      viaCost: z.number().optional(),
      effort: z.number().optional(),
      /** JS router: `laser-prefab` changes layers only through the board's free vias and claims them. */
      preset: z.enum(["default", "laser-prefab"]).optional(),
    })
    .optional(),
  freerouting: z.object({ passes: z.number().optional(), mode: z.string().optional() }).optional(),
  message: z.string().optional(),
  refillZones: z.boolean().optional(),
});
export type FpPcbRouteRequest = z.infer<typeof FpPcbRouteRequest>;

export const FpPcbRouteJob = z.object({
  id: z.string(),
  router: z.string().optional(),
  state: FpPcbRouteJobState,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  progress: FpPcbRouteProgress.optional(),
  log: z.array(z.string()).default([]),
  summary: FpPcbRouteSummary.optional(),
  error: z.string().optional(),
});
export type FpPcbRouteJob = z.infer<typeof FpPcbRouteJob>;

export const FP_PCB_ROUTE_TERMINAL_STATES: ReadonlySet<FpPcbRouteJobState> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/**
 * `circuit.netlist.json` — the design source fabdesk projects carry, i.e. `@fp-pcb/compile`'s
 * `NetlistJsonFile`: what exists and what connects to what, plus the board size and the libraries
 * the footprints resolve against. The compiler validates it; this schema is what fabdesk's own
 * tools (BOM, SPICE, the agent guide) read.
 */
export const NetlistComponent = z.object({
  ref: z.string(),
  value: z.string(),
  footprint: z.string(),
  libSource: z
    .object({ lib: z.string(), part: z.string(), description: z.string().optional() })
    .optional(),
  fields: z.record(z.string(), z.string()).optional(),
  uuid: z.string().optional(),
});
export type NetlistComponent = z.infer<typeof NetlistComponent>;

export const NetlistNode = z.object({
  ref: z.string(),
  pin: z.string(),
  pinFunction: z.string().optional(),
  pinType: z.string().optional(),
});
export type NetlistNode = z.infer<typeof NetlistNode>;

export const NetlistNet = z.object({
  name: z.string(),
  code: z.number().optional(),
  nodes: z.array(NetlistNode),
});
export type NetlistNet = z.infer<typeof NetlistNet>;

export const Netlist = z.object({
  components: z.array(NetlistComponent),
  nets: z.array(NetlistNet),
  design: z
    .object({
      source: z.string().optional(),
      date: z.string().optional(),
      tool: z.string().optional(),
    })
    .optional(),
});
export type Netlist = z.infer<typeof Netlist>;

export const NetlistLibrary = z.object({
  kind: z.enum(["footprint", "symbol"]),
  nickname: z.string(),
  uri: z.string(),
  description: z.string().optional(),
});
export type NetlistLibrary = z.infer<typeof NetlistLibrary>;

export const NetlistFile = z.object({
  netlist: Netlist,
  board: FpPcbBoardSpec.optional(),
  libraries: z.array(NetlistLibrary).optional(),
});
export type NetlistFile = z.infer<typeof NetlistFile>;

export const NETLIST_FILE = "circuit.netlist.json";
