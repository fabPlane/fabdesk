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
});

export const FpPcbCompileResult = z.object({
  ok: z.boolean(),
  diagnostics: z.array(FpPcbDiagnostic).default([]),
  counts: FpPcbCompileCounts.default({
    components: 0,
    nets: 0,
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

export const FpPcbBoardSpec = z.object({
  outline: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  widthMm: z.number().optional(),
  heightMm: z.number().optional(),
  copperLayers: z.number().optional(),
});

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
