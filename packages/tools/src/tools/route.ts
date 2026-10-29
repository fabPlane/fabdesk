/** Route toolset + the shared `route_run` implementation used by the core toolset. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { CinemaShape, RouteResult } from "@fabdesk/protocol";
import { PROJECT_FILES, writeAtomic, writeJson } from "../fs";
import { DEFAULT_ROUTE_FRAME_MAX_BYTES, FrameSink } from "../frame-sink";
import {
  ToolError,
  NativeRevisionConflict,
  JobTimeoutError,
  defineTool,
  type ProjectHandle,
  type ToolContext,
  type ToolOutput,
} from "../registry";
import type { RouteProgress, RouteRunRecord, RouteSummary } from "../services";
import { ok, p, throwIfAborted } from "./common";
import { rowPoints } from "./spatial";
import {
  readCopper,
  copperBoard,
  netFacts,
  quality,
  qualityText,
  boundedQualityText,
  compareQuality,
  projectPairs,
  referenceFacts,
  consumeReference,
  type PairDefinition,
} from "../routing-quality";
import { installHintFor, runTraceMaker } from "../routers";
import { preferCandidate, type CandidateScore } from "../routing-choice";
import { newRoutingDrcErrors } from "../routing-drc";

/** Default and upper bound for how long one route_run request waits for its run to finish. */
export const ROUTE_RUN_DEFAULT_WAIT_MS = 20_000;
export const ROUTE_RUN_MAX_WAIT_MS = 60_000;
/** FFC smoke: 193 s at 20 passes; dense-board reference: 532 s. Inline wait is independent. */
export const ROUTE_RUN_DEFAULT_TIMEOUT_MS = 600_000;
/** The measured 100-pass arm retained lower-skew native-safe copper; time limits still apply. */
export const ROUTE_RUN_DEFAULT_FREEROUTING_PASSES = 100;

export const RouteRunArgs = {
  router: z
    .enum(["fab_router", "freerouting", "capacity", "tracemaker"])
    .optional()
    .describe(
      "Router; capacity is a legacy fab_router alias. An unpinned project defaults to Freerouting, falling back to fab_router when unavailable or failed. Automatic selective reroutes use fab_router. Explicit Freerouting falls back only when unavailable. tracemaker is install-on-demand (Settings → Routers) and errors with an install hint if it is not installed.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 60_000)
    .default(ROUTE_RUN_DEFAULT_TIMEOUT_MS)
    .describe(
      "Per-router computation budget in milliseconds; default 10 minutes. Queue time and inline wait are separate. A deadline does not trigger fallback.",
    ),
  onlyConnections: z
    .array(z.string())
    .optional()
    .describe(
      "Route only these leftover nets. The DSN network lists just those nets; other copper stays as obstacles. Via padstacks include existing board via sizes so sessions round-trip. If nothing routes, the result lists the leftover pads.",
    ),
  targets: z
    .array(
      z.object({
        net: z.string().min(1),
        from: z.object({ x: z.number(), y: z.number() }).optional(),
        to: z.object({ x: z.number(), y: z.number() }).optional(),
      }),
    )
    .optional()
    .describe(
      "Whole-net selections only. Endpoint coordinates (from/to) are unsupported and rejected before a run starts.",
    ),
  rules: z
    .object({
      widthMm: z.number().positive().optional(),
      clearanceMm: z.number().nonnegative().optional(),
      viaDiameterMm: z.number().positive().optional(),
      viaDrillMm: z.number().positive().optional(),
      refillZones: z.boolean().optional(),
      perNet: z
        .array(
          z
            .object({
              net: z.string().min(1),
              widthMm: z.number().positive().optional(),
              viaDiameterMm: z.number().positive().optional(),
              viaDrillMm: z.number().positive().optional(),
            })
            .strict(),
        )
        .optional()
        .describe("Per-net width and via overrides; override global fields and net classes"),
      pairs: z
        .array(
          z
            .object({
              p: z.string().min(1),
              n: z.string().min(1),
              widthMm: z.number().positive().optional(),
              gapMm: z.number().nonnegative().optional(),
              skewToleranceMm: z.number().nonnegative().optional(),
            })
            .strict(),
        )
        .optional()
        .describe(
          "Declared pairs for measurement; current routers route members independently. Pair width applies to both members; conflicting per-net widths are rejected",
        ),
    })
    .optional()
    .describe(
      "Explicit routing width, clearance, via and zone rules; the router uses the board's enabled copper layers",
    ),
  settings: z.record(z.string(), z.unknown()).optional().describe("Router specific settings"),
  rerouteMode: z
    .enum(["onOpen", "always", "never"])
    .optional()
    .describe(
      "Scoped nets only: onOpen (default) makes one additional clean routing attempt when opens remain; always removes their own copper; never routes with retained copper only. Other nets stay protected; the best native-clean candidate wins.",
    ),
  freeroutingPasses: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Freerouting pass budget; default 100. The time limit still applies."),
  allowQualityRegression: z
    .array(z.enum(["narrowing", "skew"]))
    .optional()
    .describe(
      "Explicitly allow warned width narrowing or increased pair skew. Default holds these candidates for inspection; scope and native DRC errors can never be allowed.",
    ),
  applyPolicy: z
    .enum(["auto", "manual"])
    .default("auto")
    .describe(
      "auto applies only if the starting PCB revision is still current; manual preserves a candidate for route_apply",
    ),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(ROUTE_RUN_MAX_WAIT_MS)
    .default(ROUTE_RUN_DEFAULT_WAIT_MS)
    .describe(
      "Milliseconds this request waits for the run to finish (including auto apply). A run that finishes in time returns its final status; otherwise the response is the running state. 0 returns immediately. The run continues after the request returns either way.",
    ),
};

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turns route progress into event frames, then records the completed run's real copper geometry.
 * A fast board that emits no intermediate progress still gets one useful final frame.
 */
export class RouteProgressFrames {
  private seq = 0;
  private pass: number | undefined;
  private routed = 0;
  private lastStatus: string | undefined;
  constructor(
    private readonly runId: string,
    private readonly started: number,
    private readonly sink: FrameSink,
  ) {}
  onProgress(pr: RouteProgress): void {
    const elapsedMs = Date.now() - this.started;
    // The bridge reports the pass inside `phase` ("pass 3"); a numeric `pass` wins when present.
    const pass =
      pr.pass ?? (pr.phase ? Number(/pass\s+(\d+)/i.exec(pr.phase)?.[1]) || undefined : undefined);
    if (pass !== undefined && pass !== this.pass) {
      this.pass = pass;
      this.sink.onMessage({
        kind: "frame",
        runId: this.runId,
        seq: this.seq++,
        elapsedMs,
        event: { kind: "pass-start", passNo: pass },
        shapes: [],
      });
    }
    if (pr.routed !== undefined && pr.routed > this.routed) {
      for (let n = this.routed; n < pr.routed; n++) {
        this.sink.onMessage({
          kind: "frame",
          runId: this.runId,
          seq: this.seq++,
          elapsedMs,
          event: {
            kind: "connection",
            netNumber: n + 1,
            ...(pr.phase ? { status: pr.phase } : {}),
          },
          shapes: [],
        });
      }
      this.routed = pr.routed;
    } else if (pr.message || (pr.pass === undefined && pr.routed === undefined && pr.phase)) {
      // The JS router reports only a solver phase and a percentage (no passes, no routed count);
      // without this the cinema sat on "waiting for frames…" for the whole run.
      const status =
        pr.message ?? `${pr.phase}${pr.percent !== undefined ? ` · ${pr.percent}%` : ""}`;
      if (status && status !== this.lastStatus) {
        this.lastStatus = status;
        this.sink.onMessage({
          kind: "frame",
          runId: this.runId,
          seq: this.seq++,
          elapsedMs,
          event: { kind: "attempt", status },
          shapes: [],
        });
      }
    }
  }
  fallback(reason: string): void {
    this.pass = undefined;
    this.routed = 0;
    this.lastStatus = undefined;
    this.sink.onMessage({
      kind: "frame",
      runId: this.runId,
      seq: this.seq++,
      elapsedMs: Date.now() - this.started,
      event: { kind: "attempt", status: `fab_router fallback: ${reason}` },
      shapes: [],
    });
  }
  complete(shapes: CinemaShape[], total: number): void {
    this.sink.onMessage({
      kind: "frame",
      runId: this.runId,
      seq: this.seq++,
      elapsedMs: Date.now() - this.started,
      event: { kind: "done", ...(total ? { status: `${total} connection(s)` } : {}) },
      shapes,
    });
  }
}

/** Stable numeric id for the cinema wire format (source geometry keeps its string KIID). */
export function cinemaId(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** KiCad copper-layer enums are F.Cu=3, In1.Cu=4… and B.Cu=34. */
export function cinemaLayer(layer: number, count: number): number {
  if (layer < 0) return -1;
  if (layer === 34) return Math.max(0, count - 1);
  return Math.max(0, Math.min(count - 1, layer - 3));
}

type RouteArgs = {
  router?: "fab_router" | "capacity" | "freerouting" | "tracemaker";
  timeoutMs: number;
  onlyConnections?: string[];
  targets?: Array<{
    net: string;
    from?: { x: number; y: number } | undefined;
    to?: { x: number; y: number } | undefined;
  }>;
  rules?: {
    widthMm?: number | undefined;
    clearanceMm?: number | undefined;
    viaDiameterMm?: number | undefined;
    viaDrillMm?: number | undefined;
    refillZones?: boolean | undefined;
    perNet?:
      | Array<{
          net: string;
          widthMm?: number | undefined;
          viaDiameterMm?: number | undefined;
          viaDrillMm?: number | undefined;
        }>
      | undefined;
    pairs?: PairDefinition[] | undefined;
  };
  settings?: Record<string, unknown>;
  rerouteMode?: "onOpen" | "always" | "never";
  freeroutingPasses?: number;
  allowQualityRegression?: Array<"narrowing" | "skew">;
  applyPolicy: "auto" | "manual";
  /** How long this request waits for a terminal run; 0 or absent returns the running state at once. */
  waitMs?: number;
  fallbackOnFailure?: boolean;
};

const iso = () => new Date().toISOString();
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const terminalStates = new Set(["cancelled", "completed", "failed", "timed_out", "interrupted"]);

function compactRecord(rec: RouteRunRecord) {
  return rec;
}

function stableRows(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
}

async function boardInventory(ctx: ToolContext, dir: string) {
  const selects = [
    "components",
    "footprint_geometry",
    "board_geometry",
    "pads",
    "tracks",
    "vias",
    "zones",
    "keepouts",
    "texts",
    "unrouted",
  ] as const;
  const values = await Promise.all(selects.map((select) => ctx.services.design.query(dir, select)));
  const rows = Object.fromEntries(
    selects.map((select, index) => [select, values[index]!]),
  ) as Record<(typeof selects)[number], Array<Record<string, unknown>>>;
  // Net codes and unused declarations are serialization details. Routing may replace copper,
  // but must preserve assigned net names and every physical pad's net assignment.
  const assignedNames = new Set(
    [...rows.pads, ...rows.tracks, ...rows.vias, ...rows.zones]
      .map((row) => String(row["net"] ?? ""))
      .filter(Boolean),
  );
  const nets = stableRows([
    ...[...assignedNames].map((name) => ({ name })),
    ...rows.pads.map((pad) => ({
      x: pad["x"],
      y: pad["y"],
      layer: pad["layer"],
      component: pad["component"],
      number: pad["number"],
      net: pad["net"] ?? "",
    })),
  ]);
  return {
    ...Object.fromEntries(selects.map((select) => [select, stableRows(rows[select])])),
    nets,
  } as Record<(typeof selects)[number] | "nets", string[]>;
}

function inventoryDiff(
  before: Awaited<ReturnType<typeof boardInventory>>,
  after: Awaited<ReturnType<typeof boardInventory>>,
) {
  const names: Record<string, keyof typeof before> = {
    footprintPlacement: "components",
    footprintGeometry: "footprint_geometry",
    outline: "board_geometry",
    nets: "nets",
    tracks: "tracks",
    vias: "vias",
    zones: "zones",
    keepouts: "keepouts",
    texts: "texts",
    remainingConnectivity: "unrouted",
  };
  return Object.fromEntries(
    Object.entries(names).map(([name, key]) => {
      const a = before[key],
        b = after[key];
      const sa = new Set(a),
        sb = new Set(b);
      const changed = a.filter((v) => !sb.has(v)).length + b.filter((v) => !sa.has(v)).length;
      return [name, { before: a.length, after: b.length, changed }];
    }),
  );
}

function forbiddenDiff(diff: Record<string, { changed: number }>, allowZones: boolean): string[] {
  return [
    "footprintPlacement",
    "footprintGeometry",
    "outline",
    "nets",
    "keepouts",
    "texts",
    ...(allowZones ? [] : ["zones"]),
  ].filter((key) => (diff[key]?.changed ?? 0) > 0);
}

// Every progress producer shares this queue. Capture bytes at enqueue time, so a later
// terminal/application record cannot be overwritten by a delayed earlier heartbeat.
const progressQueues = new Map<string, Promise<void>>();
async function persistProgress(ctx: ToolContext, rec: RouteRunRecord, runDir: string) {
  ctx.services.routeRuns.update(rec.id, rec);
  const path = join(runDir, "progress.json");
  const data = JSON.stringify(compactRecord(rec), null, 2) + "\n";
  const pending = (progressQueues.get(path) ?? Promise.resolve())
    .then(() => writeAtomic(path, data))
    .catch((error: unknown) => {
      console.error(`route ${rec.id}: progress write failed: ${String(error)}`);
    });
  progressQueues.set(path, pending);
  await pending;
  if (progressQueues.get(path) === pending) progressQueues.delete(path);
}

async function applyCandidate(
  ctx: ToolContext,
  rec: RouteRunRecord,
  expectedRevision: string,
  allowed: Array<"narrowing" | "skew"> = [],
): Promise<RouteRunRecord> {
  const project = ctx.requireProject();
  if (rec.projectId !== project.id)
    throw new ToolError(`route ${rec.id} belongs to another project`, "precondition");
  if (!rec.candidate.available || !rec.candidate.reopenable)
    throw new ToolError(`route ${rec.id} has no validated candidate`, "precondition");
  if (rec.application.state === "rejected")
    throw new ToolError(rec.application.reason ?? "route candidate was rejected", "precondition");
  const blocked = (rec.result?.quality?.warnings ?? []).filter((w) => !allowed.includes(w.kind));
  if (blocked.length)
    throw new ToolError(
      `quality warning requires allowQualityRegression: ${blocked.map((w) => w.text).join("; ")}`,
      "precondition",
    );
  const boardPath = p(project, PROJECT_FILES.boardPcb);
  const before = await readFile(boardPath);
  const current = sha256(before);
  if (current !== expectedRevision || current !== rec.startingPcbRevision) {
    const next = {
      ...rec,
      currentPcbRevision: current,
      canonicalMatchesStart: false,
      application: {
        ...rec.application,
        state: "stale" as const,
        reason: `stale PCB revision: expected ${expectedRevision}, start ${rec.startingPcbRevision}, actual ${current}`,
      },
    };
    await persistProgress(ctx, next, p(project, rec.artifacts.runDir));
    throw new ToolError(next.application.reason!, "precondition");
  }
  const candidatePath = p(project, rec.candidate.path);
  const candidate = await readFile(candidatePath);
  if (sha256(candidate) !== rec.candidate.sha256)
    throw new ToolError("candidate hash no longer matches its durable identity", "precondition");
  let next: RouteRunRecord = {
    ...rec,
    application: { ...rec.application, state: "applying", reason: null },
  };
  await persistProgress(ctx, next, p(project, rec.artifacts.runDir));
  try {
    const replace = async () => {
      const check = sha256(await readFile(boardPath));
      if (check !== current)
        throw new NativeRevisionConflict(`PCB changed before atomic replace: ${check}`);
      await writeAtomic(boardPath, candidate);
    };
    if (ctx.services.design.withSavedFilesRecovery)
      await ctx.services.design.withSavedFilesRecovery(project.dir, replace);
    else {
      await ctx.services.design.release(project.dir);
      await replace();
    }
    await ctx.services.design.release(project.dir).catch(() => undefined);
    await ctx.services.design.query(project.dir, "nets");
    const resulting = sha256(await readFile(boardPath));
    if (resulting !== rec.candidate.sha256)
      throw new Error(
        `reopened board hash ${resulting} differs from candidate ${rec.candidate.sha256}`,
      );
    if (rec.result?.quality) {
      const facts = JSON.parse(
        await readFile(p(project, rec.result.quality.detailPath), "utf8"),
      ) as { nets: Array<{ net: string }> };
      await consumeReference(
        project.dir,
        current,
        resulting,
        facts.nets.map((n) => n.net).filter((net) => !rec.result!.open.includes(net)),
      );
    }
    next = {
      ...next,
      currentPcbRevision: resulting,
      canonicalMatchesStart: false,
      application: {
        ...next.application,
        state: "applied",
        resultingPcbRevision: resulting,
        appliedAt: iso(),
        reason: null,
      },
    };
    const statsPath = p(project, PROJECT_FILES.reports, "stats.json");
    await rm(statsPath, { force: true });
    const cli = await ctx.services.kicad.resolveCli();
    if (cli)
      await ctx.services.kicad
        .boardStats(cli, { board: boardPath, scratchFile: statsPath })
        .catch(() => undefined);
  } catch (error) {
    // Refusal is not a failed replacement: preserve live work and any external saved revision.
    // In particular, do not run the generic release/rollback path after the recovery guard refuses.
    if (error instanceof NativeRevisionConflict) {
      next = {
        ...next,
        application: { ...next.application, state: "failed", reason: error.message },
      };
      await persistProgress(ctx, next, p(project, rec.artifacts.runDir));
      throw error;
    }
    await ctx.services.design.release(project.dir).catch(() => undefined);
    await writeAtomic(boardPath, before);
    await ctx.services.design.release(project.dir).catch(() => undefined);
    const restored = sha256(await readFile(boardPath));
    const message = error instanceof Error ? error.message : String(error);
    next = {
      ...next,
      currentPcbRevision: restored,
      canonicalMatchesStart: restored === rec.startingPcbRevision,
      application: {
        ...next.application,
        state: "failed",
        reason: `${message}; prior board restored (${restored})`,
      },
    };
    await persistProgress(ctx, next, p(project, rec.artifacts.runDir));
    throw error;
  }
  await persistProgress(ctx, next, p(project, rec.artifacts.runDir));
  return next;
}

async function executeRoute(
  args: RouteArgs,
  ctx: ToolContext,
  initial: RouteRunRecord,
  snapshotDir: string,
  signal: AbortSignal,
) {
  const project = ctx.requireProject();
  const runDir = p(project, initial.artifacts.runDir);
  const framesPath = p(project, initial.artifacts.frames);
  const started = Date.now();
  let rec: RouteRunRecord = {
    ...initial,
    state: "running",
    status: "running",
    startedAt: iso(),
    updatedAt: iso(),
    progress: { ...initial.progress, phase: "preflight", measuredAt: iso(), heartbeatAt: iso() },
  };
  await persistProgress(ctx, rec, runDir);
  const sink = new FrameSink(framesPath, ctx.services.bus);
  const frameCapture = () => ({
    bytes: sink.stats.bytes,
    maxBytes: DEFAULT_ROUTE_FRAME_MAX_BYTES,
    truncated: sink.stats.truncated,
    droppedBytes: sink.stats.droppedBytes,
    framesReceived: sink.stats.frames,
  });
  // frames.json is diagnostic metadata: failing to write it must not fail a finished route.
  const persistFrameCapture = () =>
    writeJson(join(runDir, "frames.json"), frameCapture()).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  const frames = new RouteProgressFrames(rec.id, started, sink);
  let cancelPromise: Promise<void> | null = null;
  let preflightQuality: RouteResult["quality"];
  signal.addEventListener(
    "abort",
    () => {
      const at = iso();
      rec = {
        ...rec,
        state: "cancelling",
        status: "cancelling",
        progress: {
          ...rec.progress,
          phase: "cancelling",
          elapsedMs: Date.now() - started,
          measuredAt: at,
          heartbeatAt: at,
        },
      };
      ctx.services.routeRuns.update(rec.id, rec);
      cancelPromise = ctx.services.design.cancelRoute(snapshotDir).catch(() => undefined);
    },
    { once: true },
  );
  try {
    throwIfAborted(signal);
    const beforeInventory = await boardInventory(ctx, snapshotDir);
    const startingCopper = await readCopper(snapshotDir);
    const drcCli = await ctx.services.kicad.resolveCli();
    if (!drcCli)
      throw new ToolError(
        "Routing requires native DRC before candidate application; KiCad CLI is unavailable",
        "precondition",
      );
    const beforeDrc = drcCli
      ? await ctx.services.kicad.runDrc(drcCli, {
          board: join(snapshotDir, PROJECT_FILES.boardPcb),
          outFile: join(runDir, "routing-drc-before.json"),
          severity: "all",
          refillZones: true,
          signal,
        })
      : null;
    const allEndpoints = await ctx.services.design.query(snapshotDir, "unrouted");
    const requestedNets = [
      ...new Set([
        ...(args.onlyConnections ?? []),
        ...(args.targets ?? []).map((target) => target.net),
      ]),
    ];
    const endpoints = allEndpoints.filter(
      (row) => !requestedNets.length || requestedNets.includes(String(row["net"])),
    );
    const endpointNets = new Set(endpoints.map((row) => String(row["net"] ?? "")));
    const missing = requestedNets.filter(
      (net) => !endpointNets.has(net) && !startingCopper.nets.includes(net),
    );
    if (missing.length)
      throw new ToolError(`no remaining endpoints for ${missing.join(", ")}`, "precondition");
    const reference = await referenceFacts(project.dir, rec.startingPcbRevision);
    const detectedPairs = await projectPairs(snapshotDir, startingCopper, args.rules?.pairs);
    const beforeQuality = quality(
      startingCopper,
      requestedNets.length ? requestedNets : startingCopper.nets,
      detectedPairs,
      reference,
    );
    preflightQuality = {
      text: `Opens: ${endpoints.length} → unavailable; candidate not validated. Copper outside request: unmeasured.\n${qualityText(beforeQuality)}`,
      detailPath: join(rec.artifacts.runDir, "quality.json"),
      warnings: [],
    };
    await writeJson(join(runDir, "quality.json"), {
      ...beforeQuality,
      candidate: "not yet validated",
      opensBefore: endpoints.length,
    });
    const perNet = new Map((args.rules?.perNet ?? []).map((r) => [r.net, { ...r }]));
    if (!args.allowQualityRegression?.includes("narrowing")) {
      for (const n of [
        ...netFacts(startingCopper, requestedNets.length ? requestedNets : startingCopper.nets),
        ...reference,
      ]) {
        if (requestedNets.length && !requestedNets.includes(n.net)) continue;
        // Keep the widest retained/reference copper as the floor: this policy was benchmarked
        // with the routing harness. A minimum-width floor needs its own quality measurement.
        const floor = Math.max(0, ...n.widthsMm);
        if (!floor) continue;
        const own = perNet.get(n.net);
        const requested =
          own?.widthMm ??
          args.rules?.pairs?.find((p) => p.p === n.net || p.n === n.net)?.widthMm ??
          args.rules?.widthMm ??
          0;
        perNet.set(n.net, { ...own, net: n.net, widthMm: Math.max(floor, requested) });
      }
    }
    const requestedPairWidth = (pair: PairDefinition, net: string) =>
      args.rules?.perNet?.find((p) => p.net === net)?.widthMm ??
      args.rules?.pairs?.find((p) => p.p === pair.p && p.n === pair.n)?.widthMm ??
      args.rules?.widthMm ??
      pair.widthMm ??
      0;
    for (const pair of detectedPairs) {
      if (pair.source === "identified by name") continue;
      const width = Math.max(
        Math.max(requestedPairWidth(pair, pair.p), perNet.get(pair.p)?.widthMm ?? 0),
        Math.max(requestedPairWidth(pair, pair.n), perNet.get(pair.n)?.widthMm ?? 0),
      );
      if (width)
        for (const net of [pair.p, pair.n])
          perNet.set(net, { ...perNet.get(net), net, widthMm: width });
    }
    const effectivePairs = detectedPairs.map(({ source, ...pair }) => ({
      ...pair,
      ...(pair.widthMm !== undefined
        ? {
            widthMm: Math.max(
              requestedPairWidth(pair, pair.p),
              requestedPairWidth(pair, pair.n),
              perNet.get(pair.p)?.widthMm ?? 0,
              perNet.get(pair.n)?.widthMm ?? 0,
            ),
          }
        : {}),
    }));
    const ruleSettings: Record<string, unknown> = {
      ...(args.settings ?? {}),
      ...(perNet.size ? { perNet: [...perNet.values()] } : {}),
      ...(effectivePairs.length ? { differentialPairs: effectivePairs } : {}),
      ...(args.rules?.widthMm !== undefined ? { trackWidthMm: args.rules.widthMm } : {}),
      ...(args.rules?.clearanceMm !== undefined ? { clearanceMm: args.rules.clearanceMm } : {}),
      ...(args.rules?.viaDiameterMm !== undefined
        ? { viaDiameterMm: args.rules.viaDiameterMm }
        : {}),
      ...(args.rules?.viaDrillMm !== undefined ? { viaDrillMm: args.rules.viaDrillMm } : {}),
    };
    const board = project.manifest().board;
    if (board.template !== undefined && ruleSettings["preset"] === undefined)
      ruleSettings["preset"] = "laser-prefab";
    const outlineRows = await ctx.services.design
      .query(snapshotDir, "board_geometry")
      .catch(() => []);
    const points = outlineRows.flatMap(rowPoints);
    sink.onMessage({
      kind: "meta",
      runId: rec.id,
      router: rec.router,
      bounds: points.length
        ? {
            x1: Math.min(...points.map((v) => v.x)),
            y1: Math.min(...points.map((v) => v.y)),
            x2: Math.max(...points.map((v) => v.x)),
            y2: Math.max(...points.map((v) => v.y)),
          }
        : { x1: 0, y1: 0, x2: board.widthMm ?? 0, y2: board.heightMm ?? 0 },
      layers: Array.from({ length: board.layers }, (_, i) =>
        i === 0 ? "F.Cu" : i === board.layers - 1 ? "B.Cu" : `In${i}.Cu`,
      ),
      unitsPerMm: 1,
    });
    try {
      const [pads, vias, nets] = await Promise.all([
        ctx.services.design.query(snapshotDir, "pads"),
        ctx.services.design.query(snapshotDir, "vias"),
        ctx.services.design.query(snapshotDir, "nets"),
      ]);
      const netCodes = new Map(
        nets.map((row) => [String(row["name"] ?? ""), Number(row["code"] ?? 0)]),
      );
      const statics: CinemaShape[] = [];
      for (const pad of pads) {
        const x = Number(pad["x"] ?? 0),
          y = Number(pad["y"] ?? 0),
          w = Number(pad["width"] ?? 0),
          h = Number(pad["height"] ?? 0);
        statics.push({
          k: "pad",
          id: cinemaId(String(pad["id"] ?? `${pad["component"]}:${pad["number"]}:${x}:${y}`)),
          layer: cinemaLayer(Number(pad["layer"] ?? 3), board.layers),
          net: netCodes.get(String(pad["net"] ?? "")) ?? 0,
          pts: [x - w / 2, y - h / 2, x + w / 2, y + h / 2],
        });
      }
      for (const via of vias) {
        const x = Number(via["x"] ?? 0),
          y = Number(via["y"] ?? 0),
          d = Number(via["diameter"] ?? 0);
        statics.push({
          k: "via",
          id: cinemaId(String(via["id"] ?? `${x}:${y}`)),
          layer: -1,
          net: netCodes.get(String(via["net"] ?? "")) ?? 0,
          pts: [x - d / 2, y - d / 2, x + d / 2, y + d / 2],
        });
      }
      sink.onMessage({ kind: "static", runId: rec.id, shapes: statics });
    } catch {
      // Static cinema context is optional; durable route execution is not.
    }
    let routingTimedOut = false;
    const attemptRoute = async (scopeNets = requestedNets): Promise<RouteSummary> => {
      await ctx.services.design.release(snapshotDir);
      const attemptPcb = await readFile(join(snapshotDir, PROJECT_FILES.boardPcb));
      const attemptPro = await readFile(join(snapshotDir, PROJECT_FILES.boardPro));
      const attempt = {
        router: rec.router as "fab_router" | "freerouting" | "tracemaker",
        startedAt: iso(),
        endedAt: null as string | null,
        outcome: "running" as const,
        reason: null as string | null,
      };
      rec = { ...rec, attempts: [...(rec.attempts ?? []), attempt] };
      await persistProgress(ctx, rec, runDir);
      try {
        if (rec.router === "tracemaker") {
          const binary = ctx.services.routers?.executable("tracemaker");
          if (!binary) {
            throw new ToolError(
              installHintFor("tracemaker", ctx.services.routers?.get("tracemaker")),
              "unavailable",
            );
          }
          return await runTraceMaker({
            binary,
            snapshotDir,
            timeoutMs: args.timeoutMs,
            signal,
            onProgress: (value) => {
              frames.onProgress(value);
            },
          });
        }
        const summary = await ctx.services.design.route(
          snapshotDir,
          {
            router: rec.router as "fab_router" | "freerouting",
            ...(rec.router === "freerouting"
              ? {
                  freerouting: {
                    passes: args.freeroutingPasses ?? ROUTE_RUN_DEFAULT_FREEROUTING_PASSES,
                  },
                }
              : {}),
            maxTimeMs: args.timeoutMs,
            ...(scopeNets.length ? { nets: scopeNets } : {}),
            ...(Object.keys(ruleSettings).length ? { settings: ruleSettings } : {}),
            ...(args.rules?.refillZones !== undefined
              ? { refillZones: args.rules.refillZones }
              : {}),
          },
          {
            signal,
            onProgress: (value) => {
              frames.onProgress(value);
              const at = iso();
              const diagnostics = [
                ...rec.progress.diagnostics,
                ...(value.log ?? []),
                ...(value.message ? [value.message] : []),
              ].slice(-20);
              rec = {
                ...rec,
                progress: {
                  phase: value.phase ?? value.state,
                  pass: value.pass ?? rec.progress.pass,
                  routed: value.routed ?? rec.progress.routed,
                  total: value.total ?? rec.progress.total,
                  remaining:
                    value.total !== undefined && value.routed !== undefined
                      ? Math.max(0, value.total - value.routed)
                      : rec.progress.remaining,
                  violations: value.violations ?? rec.progress.violations,
                  elapsedMs: Date.now() - started,
                  measuredAt: at,
                  heartbeatAt: at,
                  diagnostics,
                },
                updatedAt: at,
              };
              void persistProgress(ctx, rec, runDir);
            },
          },
        );
        routingTimedOut ||= summary.timedOut;
        rec = {
          ...rec,
          attempts: rec.attempts!.map((value, index) =>
            index === rec.attempts!.length - 1
              ? {
                  ...value,
                  endedAt: iso(),
                  outcome: summary.timedOut ? "timed_out" : "completed",
                  reason: summary.message,
                }
              : value,
          ),
        };
        return summary;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof JobTimeoutError;
        rec = {
          ...rec,
          attempts: rec.attempts!.map((value, index) =>
            index === rec.attempts!.length - 1
              ? {
                  ...value,
                  endedAt: iso(),
                  outcome: signal.aborted ? "cancelled" : timedOut ? "timed_out" : "failed",
                  reason: message,
                }
              : value,
          ),
        };
        // Cancellation and a routing deadline are not solver failures. Preserve their outcome.
        if (signal.aborted || timedOut || rec.router !== "freerouting" || !args.fallbackOnFailure)
          throw error;
        await progressQueues.get(join(runDir, "progress.json"));
        await ctx.services.design.release(snapshotDir);
        // Restore this attempt's input, including retained first-pass or freshly cleaned copper.
        await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), attemptPcb);
        await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), attemptPro);
        rec = { ...rec, router: "fab_router", fallbackReason: `Freerouting failed: ${message}` };
        frames.fallback(rec.fallbackReason!);
        await persistProgress(ctx, rec, runDir);
        return attemptRoute(scopeNets);
      }
    };
    const retryMode = args.rerouteMode ?? "onOpen";
    const scopeHasLockedCopper = startingCopper.copper.some(
      (item) => item.locked && requestedNets.includes(item.net),
    );
    if (scopeHasLockedCopper && retryMode !== "never")
      rec.progress.diagnostics.push("Clean retry skipped: requested nets contain locked copper.");
    const clean = async () => {
      if (!requestedNets.length)
        throw new ToolError("rerouteMode requires explicit requested nets", "precondition");
      // Internal unroute removes every item on a net. Keep the original route when locked
      // copper is present rather than discarding the user's protected geometry.
      if (scopeHasLockedCopper) return;
      await ctx.services.design.release(snapshotDir);
      await copyFile(join(runDir, "starting.kicad_pcb"), join(snapshotDir, PROJECT_FILES.boardPcb));
      await copyFile(join(runDir, "starting.kicad_pro"), join(snapshotDir, PROJECT_FILES.boardPro));
      const removed = await ctx.services.design.unroute(snapshotDir, requestedNets);
      rec.progress.diagnostics.push(
        `Clean retry: removed ${removed.tracks} tracks and ${removed.vias} vias on requested nets only.`,
      );
      await ctx.services.design.release(snapshotDir);
    };
    const score = async (value: RouteSummary, label: string): Promise<CandidateScore> => {
      const copper = await readCopper(snapshotDir);
      const scope = new Set(requestedNets.length ? requestedNets : startingCopper.nets);
      const outside = (b: typeof copper) =>
        b.copper
          .filter((c) => !scope.has(c.net))
          .map((c) => c.signature)
          .sort();
      const outsideScope =
        JSON.stringify(outside(startingCopper)) === JSON.stringify(outside(copper)) ? 0 : 1;
      const drc = await ctx.services.kicad.runDrc(drcCli!, {
        board: join(snapshotDir, PROJECT_FILES.boardPcb),
        outFile: join(runDir, `${label}-drc.json`),
        severity: "all",
        refillZones: true,
        signal,
      });
      const facts = quality(
        copper,
        requestedNets.length ? requestedNets : copper.nets,
        detectedPairs,
        reference,
      );
      return {
        opens: value.unrouted.length,
        newErrors: newRoutingDrcErrors(beforeDrc!, drc).length,
        outsideScope,
        skewMm: facts.pairs
          .filter((p) => !scope.size || scope.has(p.p) || scope.has(p.n))
          .reduce((sum, p) => sum + p.skewMm, 0),
        vias: facts.nets.reduce((s, n) => s + n.viaCount, 0),
        lengthMm: facts.nets.reduce((s, n) => s + n.lengthMm, 0),
      };
    };
    if (retryMode === "always") await clean();
    let summary = await attemptRoute();
    if (
      requestedNets.length &&
      retryMode === "onOpen" &&
      summary.unrouted.length &&
      !routingTimedOut &&
      !scopeHasLockedCopper &&
      !signal.aborted
    ) {
      await ctx.services.design.release(snapshotDir);
      const first = await readFile(join(snapshotDir, PROJECT_FILES.boardPcb));
      const firstPro = await readFile(join(snapshotDir, PROJECT_FILES.boardPro));
      const firstRouter = rec.router,
        firstFallback = rec.fallbackReason ?? null;
      const beforeScore = await score(summary, "retained");
      const trials: unknown[] = [{ kind: "retained", score: beforeScore }];
      try {
        await clean();
        const retry = await attemptRoute();
        await ctx.services.design.release(snapshotDir);
        const afterScore = await score(retry, "clean-retry");
        const selected = preferCandidate(beforeScore, afterScore);
        trials.push({ kind: "clean-retry", score: afterScore, selected });
        if (selected) summary = retry;
        else {
          await ctx.services.design.release(snapshotDir);
          await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), first);
          await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), firstPro);
          rec = { ...rec, router: firstRouter, fallbackReason: firstFallback };
        }
      } catch (error) {
        if (signal.aborted) throw error;
        trials.push({ kind: "clean-retry", error: String(error), selected: false });
        await ctx.services.design.release(snapshotDir);
        await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), first);
        await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), firstPro);
        rec = { ...rec, router: firstRouter, fallbackReason: firstFallback };
      }
      await writeJson(join(runDir, "retry.json"), trials);
      summary.log.push(
        `Clean retry attempted once; selected by opens, new errors, skew, vias, length. Detail: retry.json.`,
      );
    }
    const pairAttempts: unknown[] = [];
    const initialFacts = quality(
      await readCopper(snapshotDir),
      requestedNets.length ? requestedNets : startingCopper.nets,
      detectedPairs,
      reference,
    );
    for (const warning of compareQuality(
      beforeQuality,
      initialFacts,
      { before: endpoints.length, after: summary.unrouted.length },
      0,
    ).warnings.filter((w) => w.kind === "skew")) {
      const pair = detectedPairs.find((p) => warning.text.startsWith(`${p.p}/${p.n}:`));
      if (
        retryMode === "never" ||
        !requestedNets.length ||
        routingTimedOut ||
        !pair ||
        pair.source === "identified by name" ||
        startingCopper.copper.some((item) => item.locked && [pair.p, pair.n].includes(item.net)) ||
        (requestedNets.length &&
          (!requestedNets.includes(pair.p) || !requestedNets.includes(pair.n)))
      )
        continue;
      if (signal.aborted) throwIfAborted(signal);
      await ctx.services.design.release(snapshotDir);
      const prior = await readFile(join(snapshotDir, PROJECT_FILES.boardPcb));
      const priorPro = await readFile(join(snapshotDir, PROJECT_FILES.boardPro));
      const priorRouter = rec.router,
        priorFallback = rec.fallbackReason ?? null;
      const priorSummary = summary;
      const priorScore = await score(summary, `pair-${pairAttempts.length}-before`);
      try {
        await ctx.services.design.unroute(snapshotDir, [pair.p, pair.n]);
        const routed = await attemptRoute([pair.p, pair.n]);
        // Native connectivity for the original scope, not only the just-routed pair.
        const rows = await ctx.services.design.query(snapshotDir, "unrouted");
        const allOpen = rows.filter(
          (row) => !requestedNets.length || requestedNets.includes(String(row["net"])),
        );
        const trial = {
          ...routed,
          log: [...priorSummary.log, ...routed.log],
          ...(priorSummary.diagnostics ? { diagnostics: priorSummary.diagnostics } : {}),
          ...(priorSummary.endpointCollisions
            ? { endpointCollisions: priorSummary.endpointCollisions }
            : {}),
          ...(priorSummary.pairRouting ? { pairRouting: priorSummary.pairRouting } : {}),
          total: priorSummary.total,
          unrouted: allOpen.map((row) => ({
            net: String(row["net"]),
            from: (row["from"] as { x: number; y: number }) ?? { x: 0, y: 0 },
            to: (row["to"] as { x: number; y: number }) ?? { x: 0, y: 0 },
          })),
          geometry: [...(priorSummary.geometry ?? []), ...(routed.geometry ?? [])],
        };
        const afterScore = await score(trial, `pair-${pairAttempts.length}-after`);
        const lowerSkew = afterScore.skewMm < priorScore.skewMm - 0.001;
        const safe =
          afterScore.opens <= priorScore.opens && !afterScore.newErrors && !afterScore.outsideScope;
        const selected = lowerSkew && safe;
        pairAttempts.push({
          pair: { p: pair.p, n: pair.n },
          before: priorScore,
          after: afterScore,
          selected,
        });
        if (selected) {
          summary = trial;
          summary.routed = Math.max(0, summary.total - summary.unrouted.length);
        } else {
          await ctx.services.design.release(snapshotDir);
          await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), prior);
          await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), priorPro);
          rec = { ...rec, router: priorRouter, fallbackReason: priorFallback };
        }
      } catch (error) {
        if (signal.aborted) throw error;
        pairAttempts.push({
          pair: { p: pair.p, n: pair.n },
          error: String(error),
          selected: false,
        });
        await ctx.services.design.release(snapshotDir);
        await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), prior);
        await writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), priorPro);
        rec = { ...rec, router: priorRouter, fallbackReason: priorFallback };
      }
    }
    await writeJson(join(runDir, "pair-attempts.json"), pairAttempts);
    summary.log.push(
      `Pair routing capability: measurement-only; ${pairAttempts.length} pair-only routing attempt(s). Detail: pair-attempts.json.`,
    );
    await progressQueues.get(join(runDir, "progress.json"));
    const geometry = summary.geometry ?? [];
    const open = [...new Set(summary.unrouted.map((row) => row.net))];
    const resultState = summary.timedOut
      ? "timeout"
      : open.length === 0
        ? "complete"
        : summary.routed > 0 || geometry.length > 0
          ? "partial"
          : "no-progress";
    const obstacles = [
      ...new Set(
        summary.log.filter((line) =>
          /block|obstacle|clearance|edge|keepout|congestion/i.test(line),
        ),
      ),
    ].slice(0, 20);
    const candidateBoard = await readCopper(snapshotDir);
    const touchedNets = [
      ...new Set([
        ...endpoints.map((row) => String(row["net"] ?? "")),
        ...candidateBoard.copper
          .filter((c) => !startingCopper.copper.some((b) => b.id === c.id))
          .map((c) => c.net),
      ]),
    ].filter(Boolean);
    const copperById = new Map(candidateBoard.copper.map((item) => [item.id, item]));
    const namedGeometry = geometry
      .filter((shape) => copperById.has(shape.id))
      .map((shape) => ({
        ...shape,
        netName: copperById.get(shape.id)?.net ?? shape.netName ?? "",
      }));
    const outsideScopeChanges: NonNullable<RouteResult["outsideScopeChanges"]> = [];
    if (requestedNets.length) {
      const scope = new Set(requestedNets);
      const counts = new Map<
        string,
        {
          net: string;
          traces: number;
          vias: number;
          added: { traces: number; vias: number };
          removed: { traces: number; vias: number };
        }
      >();
      const count = (net: string, via: boolean, change: "added" | "removed") => {
        if (!net || scope.has(net)) return;
        const row = counts.get(net) ?? {
          net,
          traces: 0,
          vias: 0,
          added: { traces: 0, vias: 0 },
          removed: { traces: 0, vias: 0 },
        };
        const key = via ? "vias" : "traces";
        row[change][key]++;
        row[key]++;
        counts.set(net, row);
      };
      // Geometry includes newly created or claimed items; union with the saved-board delta,
      // because a solver may omit new copper from its summary. Count each UUID once.
      const additions = new Map(
        namedGeometry.map((shape) => [shape.id, { net: shape.netName, via: shape.kind === "via" }]),
      );
      const startIds = new Map(startingCopper.copper.map((item) => [item.id, item.signature]));
      const candidateIds = new Map(candidateBoard.copper.map((item) => [item.id, item.signature]));
      for (const item of candidateBoard.copper)
        if (startIds.get(item.id) !== item.signature)
          additions.set(item.id, { net: item.net, via: item.diameter !== undefined });
      for (const item of additions.values()) count(item.net, item.via, "added");
      for (const item of startingCopper.copper)
        if (candidateIds.get(item.id) !== item.signature)
          count(item.net, item.diameter !== undefined, "removed");
      outsideScopeChanges.push(...[...counts.values()].sort((a, b) => a.net.localeCompare(b.net)));
    }
    const selectedNets = requestedNets.length
      ? requestedNets
      : [...new Set([...startingCopper.nets, ...touchedNets])];
    const measuredQuality = quality(candidateBoard, selectedNets, detectedPairs, reference);
    if (summary.pairRouting) measuredQuality.pairRouting = summary.pairRouting;
    const comparison = compareQuality(
      beforeQuality,
      measuredQuality,
      { before: endpoints.length, after: summary.unrouted.length },
      outsideScopeChanges.reduce((s, c) => s + c.traces + c.vias, 0),
    );
    const heldWarnings = comparison.warnings.filter(
      (w) => !args.allowQualityRegression?.includes(w.kind),
    );
    await writeJson(join(runDir, "quality.json"), {
      ...measuredQuality,
      before: beforeQuality,
      comparison,
    });
    const fullResult: RouteResult = {
      ...(summary.diagnostics ? { diagnostics: summary.diagnostics } : {}),
      ...(summary.endpointCollisions ? { endpointCollisions: summary.endpointCollisions } : {}),
      quality: {
        text: boundedQualityText(
          comparison.text +
            (summary.pairRouting
              ? "\n" +
                summary.pairRouting.pairs
                  .map(
                    (p) =>
                      `${p.p}/${p.n}: ${p.status}; capability ${summary.pairRouting!.capability}`,
                  )
                  .join("\n")
              : ""),
        ),
        warnings: comparison.warnings,
        detailPath: join(rec.artifacts.runDir, "quality.json"),
      },
      runId: rec.id,
      router: rec.router as "fab_router" | "freerouting" | "tracemaker",
      complete: [],
      open,
      timedOut: summary.timedOut,
      state: resultState,
      remainingEndpoints: summary.unrouted,
      obstacles,
      changedGeometry: namedGeometry,
      ...(outsideScopeChanges.length ? { outsideScopeChanges } : {}),
      nextActions:
        resultState === "complete"
          ? []
          : summary.diagnostics
            ? ["try Freerouting for these nets", "check remaining native opens"]
            : ["inspect route candidate", "inspect remaining connectivity"],
      stats: {
        vias: pairAttempts.some((p: any) => p.selected)
          ? candidateBoard.copper.filter((c) => c.diameter !== undefined).length
          : summary.vias,
        segments: pairAttempts.some((p: any) => p.selected)
          ? candidateBoard.copper.filter((c) => c.width !== undefined).length
          : summary.tracks,
        wallMs: Date.now() - started,
        frames: sink.stats.frames,
        viasOnFixed: summary.claimedVias,
      },
      ...(summary.preset ? { preset: summary.preset } : {}),
      detail: `${summary.message} [runtime=${ctx.services.runtimeId ?? "dev"}; router=${rec.router}]`,
    };
    const shapes: CinemaShape[] = geometry.map((shape) => ({
      k: shape.kind,
      id: cinemaId(shape.id),
      layer: cinemaLayer(shape.layer, board.layers),
      net: shape.net,
      pts: shape.points,
      ...(shape.width !== undefined ? { w: shape.width } : {}),
    }));
    frames.complete(shapes, summary.total);
    sink.onMessage({ kind: "result", runId: rec.id, result: fullResult });
    await sink.close();
    const frameMetadataError = await persistFrameCapture();
    if (frameMetadataError)
      rec = {
        ...rec,
        progress: {
          ...rec.progress,
          diagnostics: [
            ...rec.progress.diagnostics,
            `frames.json not written: ${frameMetadataError}`,
          ].slice(-20),
        },
      };
    await writeJson(join(runDir, "result.json"), {
      ...fullResult,
      summary,
      frameCapture: {
        ...frameCapture(),
        ...(frameMetadataError ? { metadataError: frameMetadataError } : {}),
      },
    });
    await writeAtomic(join(runDir, "router.log"), `${summary.log.join("\n")}\n`).catch(
      (error: unknown) => {
        console.error(`route ${rec.id}: router log write failed: ${String(error)}`);
      },
    );
    const candidatePath = join(runDir, "candidate.kicad_pcb");
    await ctx.services.design.release(snapshotDir).catch(() => undefined);
    await copyFile(join(snapshotDir, PROJECT_FILES.boardPcb), candidatePath);
    const candidateBytes = await readFile(candidatePath);
    await ctx.services.design.query(snapshotDir, "nets");
    const afterInventory = await boardInventory(ctx, snapshotDir);
    const diff = inventoryDiff(beforeInventory, afterInventory);
    await writeJson(join(runDir, "diff.json"), {
      runId: rec.id,
      startingPcbRevision: rec.startingPcbRevision,
      candidateSha256: sha256(candidateBytes),
      diff,
    });
    const forbidden = forbiddenDiff(diff, args.rules?.refillZones === true);
    if (outsideScopeChanges.length)
      forbidden.push(`copper outside request: ${outsideScopeChanges.map((c) => c.net).join(", ")}`);
    if (drcCli && beforeDrc) {
      const afterDrc = await ctx.services.kicad.runDrc(drcCli, {
        board: join(snapshotDir, PROJECT_FILES.boardPcb),
        outFile: join(runDir, "routing-drc-after.json"),
        severity: "all",
        refillZones: true,
        signal,
      });
      const newErrors = newRoutingDrcErrors(beforeDrc, afterDrc);
      await writeJson(join(runDir, "routing-drc-check.json"), {
        before: beforeDrc.counts,
        after: afterDrc.counts,
        newErrors,
        boundary:
          "native DRC with zones refilled in memory for both snapshots; opens and warnings retained separately",
      });
      rec = {
        ...rec,
        drcErrors: newErrors,
        artifacts: {
          ...rec.artifacts,
          drcCheck: join(rec.artifacts.runDir, "routing-drc-check.json"),
        },
      };
      if (newErrors.length)
        forbidden.push(
          `native DRC: ${newErrors.length} new error(s): ${[...new Set(newErrors.map((v) => v.rule))].join(", ")}`,
        );
    }
    const usableCandidate = resultState === "complete" || summary.routed > 0 || geometry.length > 0;
    const endedAt = iso();
    const compact = {
      ...fullResult,
      changedGeometryCount: fullResult.changedGeometry?.length ?? 0,
    } as Omit<RouteResult, "changedGeometry"> & { changedGeometryCount: number };
    delete (compact as Partial<RouteResult>).changedGeometry;
    rec = {
      ...rec,
      state: summary.timedOut ? "timed_out" : forbidden.length ? "failed" : "completed",
      status: summary.timedOut ? "timed_out" : forbidden.length ? "failed" : "completed",
      endedAt,
      updatedAt: endedAt,
      error: forbidden.length
        ? `candidate changed forbidden board classes: ${forbidden.join(", ")}`
        : null,
      terminalReason: summary.timedOut
        ? "requested routing deadline reached; best router-emitted candidate preserved"
        : forbidden.length
          ? `candidate rejected: ${forbidden.join(", ")}`
          : summary.message,
      result: compact,
      progress: {
        ...rec.progress,
        phase: summary.timedOut ? "timed_out" : "completed",
        routed: summary.routed,
        total: summary.total,
        remaining: summary.unrouted.length,
        elapsedMs: Date.now() - started,
        measuredAt: endedAt,
        heartbeatAt: endedAt,
        diagnostics: [...rec.progress.diagnostics, ...summary.log].slice(-20),
      },
      candidate: {
        available: usableCandidate,
        identity: usableCandidate ? `${rec.id}:${sha256(candidateBytes).slice(0, 16)}` : null,
        sha256: sha256(candidateBytes),
        bytes: (await stat(candidatePath)).size,
        path: join(rec.artifacts.runDir, "candidate.kicad_pcb"),
        reopenable: usableCandidate,
        inspectedAt: endedAt,
        limitation: !usableCandidate
          ? "Router made no usable progress; the diagnostic snapshot is not an applicable candidate."
          : rec.router === "freerouting"
            ? "Freerouting exposes an applicable candidate only after the bridge returns a summary; cancellation or process interruption may have no partial candidate."
            : null,
        diff,
      },
      application: {
        ...rec.application,
        state: forbidden.length
          ? "rejected"
          : !usableCandidate
            ? "not_available"
            : args.applyPolicy === "manual" || heldWarnings.length > 0
              ? "manual"
              : "pending",
        reason: forbidden.length
          ? `forbidden candidate deltas: ${forbidden.join(", ")}`
          : !usableCandidate
            ? summary.message ||
              "no usable route progress; inspect the run diagnostics and remaining endpoints"
            : heldWarnings.length
              ? `Candidate held: ${heldWarnings.map((w) => w.text).join("; ")}. Set allowQualityRegression to explicitly allow these costs.`
              : null,
      },
    };
    const willApply =
      !forbidden.length && !heldWarnings.length && usableCandidate && args.applyPolicy === "auto";
    // A terminal run must include the final application outcome, not an in-flight replace.
    if (willApply) rec = { ...rec, state: "running", status: "running" };
    await persistProgress(ctx, rec, runDir);
    if (willApply) {
      try {
        rec = await applyCandidate(ctx, rec, rec.startingPcbRevision, args.allowQualityRegression);
      } catch (error) {
        const current = sha256(await readFile(p(project, PROJECT_FILES.boardPcb)));
        rec = {
          ...(ctx.services.routeRuns.get(rec.id) ?? rec),
          currentPcbRevision: current,
          canonicalMatchesStart: current === rec.startingPcbRevision,
          application: {
            ...(ctx.services.routeRuns.get(rec.id) ?? rec).application,
            state: current === rec.startingPcbRevision ? "failed" : "stale",
            reason: error instanceof Error ? error.message : String(error),
          },
        };
        await persistProgress(ctx, rec, runDir);
      }
    }
    if (willApply) {
      rec = {
        ...rec,
        state: summary.timedOut ? "timed_out" : "completed",
        status: summary.timedOut ? "timed_out" : "completed",
        endedAt: iso(),
        updatedAt: iso(),
      };
      await persistProgress(ctx, rec, runDir);
    }
    ctx.services.bus.emit({ ts: Date.now(), topic: "route.done", result: fullResult });
  } catch (error) {
    await cancelPromise;
    await sink.close().catch(() => undefined);
    await persistFrameCapture();
    const endedAt = iso();
    const cancelled = signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = !cancelled && rec.attempts?.at(-1)?.outcome === "timed_out";
    const canonical = sha256(await readFile(p(project, PROJECT_FILES.boardPcb)));
    rec = {
      ...rec,
      state: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
      status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
      endedAt,
      updatedAt: endedAt,
      error: message,
      result: preflightQuality
        ? {
            runId: rec.id,
            router: rec.router as "fab_router" | "freerouting",
            complete: [],
            open: [],
            timedOut,
            state: "failed",
            detail: message,
            changedGeometryCount: 0,
            stats: {
              vias: 0,
              segments: 0,
              frames: sink.stats.frames,
              wallMs: Date.now() - started,
            },
            quality: preflightQuality,
          }
        : rec.result,
      terminalReason: cancelled
        ? "exact-run cancellation reached the route worker; canonical board was never routed"
        : message,
      currentPcbRevision: canonical,
      canonicalMatchesStart: canonical === rec.startingPcbRevision,
      progress: {
        ...rec.progress,
        phase: cancelled ? "cancelled" : "failed",
        elapsedMs: Date.now() - started,
        measuredAt: endedAt,
        diagnostics: [...rec.progress.diagnostics, message].slice(-20),
      },
      candidate: {
        ...rec.candidate,
        limitation:
          rec.router === "freerouting"
            ? "Freerouting did not return a partial session before cancellation/failure; no intermediate candidate is claimed."
            : rec.candidate.limitation,
      },
      application: {
        ...rec.application,
        state: "not_available",
        reason: cancelled ? "cancelled before candidate completion" : message,
      },
    };
    await persistProgress(ctx, rec, runDir);
  } finally {
    await ctx.services.design.release(snapshotDir).catch(() => undefined);
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

export function outsideScopeText(changes: RouteResult["outsideScopeChanges"]): string {
  if (!changes?.length) return "";
  const nets = changes.map((change) => {
    const describe = (counts: { traces: number; vias: number }) =>
      [
        counts.traces ? `${counts.traces} trace${counts.traces === 1 ? "" : "s"}` : "",
        counts.vias ? `${counts.vias} via${counts.vias === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(", ") || "0 items";
    return `${change.net} (${change.added && change.removed ? `added ${describe(change.added)}; removed ${describe(change.removed)}` : describe(change)})`;
  });
  return `\nAlso changed outside scope: ${nets.join("; ")}.`;
}

/** The route_status response for one run; route_run returns the same thing for a run that finished inline. */
async function routeStatusOutput(
  ctx: ToolContext,
  project: ProjectHandle,
  rec: RouteRunRecord,
): Promise<ToolOutput> {
  const current = sha256(await readFile(p(project, PROJECT_FILES.boardPcb)));
  // The worker may finish while the disk read yields; never publish an older application state.
  rec = ctx.services.routeRuns.get(rec.id) ?? rec;
  const run = {
    ...rec,
    currentPcbRevision: current,
    canonicalMatchesStart: current === rec.startingPcbRevision,
    heartbeatFreshnessMs: Date.now() - Date.parse(rec.progress.heartbeatAt),
  };
  ctx.services.routeRuns.update(rec.id, run);
  return ok(
    `Run ${rec.id} (${rec.router}): ${rec.state}; ${rec.progress.routed ?? "?"}/${rec.progress.total ?? "?"} routed; candidate ${rec.candidate.available ? "ready" : "unavailable"}; apply ${rec.application.state}.${rec.application.reason ? ` ${rec.application.reason}` : ""}${rec.fallbackReason ? ` Fallback: ${rec.fallbackReason}.` : ""}${rec.result?.diagnostics ? `\n${rec.result.diagnostics.text}` : rec.error ? `\n${rec.error}` : ""}${rec.result?.endpointCollisions ? `\n${rec.result.endpointCollisions.text}` : ""}${outsideScopeText(rec.result?.outsideScopeChanges)}${rec.result?.quality ? `\n${rec.result.quality.text}` : "\nQuality pending; no candidate applied."}`,
    { run },
  );
}

/**
 * Wait up to `waitMs` for the route worker to settle. Returns false on timeout or when the request
 * is aborted; neither touches the run, which keeps going under the route task coordinator.
 */
async function waitForRun(
  ctx: ToolContext,
  runId: string,
  settled: Promise<void>,
  waitMs: number,
): Promise<boolean> {
  if (ctx.signal.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;
  const reportProgress = () => {
    const { progress } = ctx.services.routeRuns.get(runId) ?? {};
    if (progress?.total) ctx.progress((progress.routed ?? 0) / progress.total, progress.phase);
  };
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
        ticker = setInterval(reportProgress, 1_000);
        onAbort = () => resolve(false);
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
  }
}

export async function runRoute(args: RouteArgs, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  // Keep legacy coordinate inputs recognizable so callers get an actionable error. The bridge
  // accepts net names only; dropping coordinates would silently broaden the requested mutation.
  if (args.targets?.some((target) => target.from !== undefined || target.to !== undefined))
    throw new ToolError(
      "route_run supports whole-net scope only; targets.from/to cannot be honored. Use net-only targets or onlyConnections if routing the whole net is intended.",
      "precondition",
    );
  const pinned = args.router ?? project.manifest().router ?? undefined;
  const preferred = ctx.services.settings().preferredRouter ?? undefined;
  // A saved default that is no longer usable (its binary was removed, or TRACEMAKER_BIN went away) must not
  // make every unpinned route fail: fall back to the automatic path and say so. An explicit router still errors.
  const staleDefault =
    pinned === undefined && preferred !== undefined && preferred !== "fab_router"
      ? ctx.services.routers?.get(preferred)
      : undefined;
  const defaultUnusable = !!staleDefault && !staleDefault.ready;
  const selected = pinned ?? (defaultUnusable ? undefined : preferred);
  const automatic = selected === undefined;
  let router: "fab_router" | "freerouting" | "tracemaker" =
    selected === "capacity" || selected === "fab_router"
      ? "fab_router"
      : selected === "tracemaker"
        ? "tracemaker"
        : "freerouting";
  if (router === "tracemaker") {
    const snap = ctx.services.routers?.get("tracemaker");
    if (!snap?.ready) {
      throw new ToolError(installHintFor("tracemaker", snap), "unavailable");
    }
  }
  let fallbackReason: string | null = defaultUnusable
    ? `Default router ${staleDefault!.displayName} is not ready (${staleDefault!.state}); using the automatic default`
    : null;
  const selective =
    automatic && ((args.onlyConnections?.length ?? 0) > 0 || (args.targets?.length ?? 0) > 0);
  if (selective) {
    router = "fab_router";
    fallbackReason = "Automatic selective reroutes use fab_router";
  }
  if (router === "freerouting") {
    const health = await ctx.services.design.status();
    if (health.routers?.freerouting?.ok === false) {
      fallbackReason = `Freerouting unavailable: ${health.routers.freerouting.reason ?? "runtime unavailable"}`;
      router = "fab_router";
    }
  }
  args = { ...args, fallbackOnFailure: automatic };
  const boardPath = p(project, PROJECT_FILES.boardPcb);
  const boardBytes = await readFile(boardPath).catch(() => {
    throw new ToolError("board.kicad_pcb does not exist; build the board first", "precondition");
  });
  const projectBytes = await readFile(p(project, PROJECT_FILES.boardPro)).catch(
    () => new Uint8Array(),
  );
  const customRules = await readFile(p(project, "board.kicad_dru")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const validationBoard = copperBoard(boardBytes.toString());
  const bad = (args.rules?.perNet ?? [])
    .map((r) => r.net)
    .concat((args.rules?.pairs ?? []).flatMap((p) => [p.p, p.n]))
    .filter((n) => !validationBoard.nets.includes(n));
  if (bad.length)
    throw new ToolError(
      `unknown routing rule nets: ${[...new Set(bad)].join(", ")}`,
      "precondition",
    );
  if (
    new Set((args.rules?.perNet ?? []).map((r) => r.net)).size !== (args.rules?.perNet?.length ?? 0)
  )
    throw new ToolError("duplicate per-net routing rules", "precondition");
  const pairMembers = new Set<string>();
  for (const pair of args.rules?.pairs ?? []) {
    if (pair.p === pair.n || pairMembers.has(pair.p) || pairMembers.has(pair.n))
      throw new ToolError(`invalid or overlapping pair ${pair.p}/${pair.n}`, "precondition");
    pairMembers.add(pair.p);
    pairMembers.add(pair.n);
    for (const member of [pair.p, pair.n]) {
      const width = args.rules?.perNet?.find((r) => r.net === member)?.widthMm;
      if (width !== undefined && pair.widthMm !== undefined && width !== pair.widthMm)
        throw new ToolError(`conflicting pair width for ${member}`, "precondition");
    }
  }
  const startingPcbRevision = sha256(boardBytes);
  const runId = newRunId();
  const runRel = join(PROJECT_FILES.runs, runId);
  const runDir = p(project, runRel);
  const snapshotDir = join(runDir, "snapshot");
  await mkdir(snapshotDir, { recursive: true });
  await Promise.all([
    writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), boardBytes),
    writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), projectBytes),
    writeAtomic(join(runDir, "starting.kicad_pcb"), boardBytes),
    writeAtomic(join(runDir, "starting.kicad_pro"), projectBytes),
    ...(customRules
      ? [
          writeAtomic(join(snapshotDir, "board.kicad_dru"), customRules),
          writeAtomic(join(runDir, "starting.kicad_dru"), customRules),
        ]
      : []),
  ]);
  const createdAt = iso();
  const artifacts = {
    runDir: runRel,
    request: join(runRel, "request.json"),
    progress: join(runRel, "progress.json"),
    frames: join(runRel, "frames.jsonl"),
    log: join(runRel, "router.log"),
    result: join(runRel, "result.json"),
    candidate: join(runRel, "candidate.kicad_pcb"),
    diff: join(runRel, "diff.json"),
  };
  const record: RouteRunRecord = {
    id: runId,
    projectId: project.id,
    router,
    fallbackReason,
    attempts: fallbackReason
      ? [
          {
            router: "freerouting",
            startedAt: createdAt,
            endedAt: createdAt,
            outcome: selective ? "skipped" : "unavailable",
            reason: fallbackReason,
          },
        ]
      : [],
    runtimeId: ctx.services.runtimeId,
    state: "queued",
    status: "queued",
    framesPath: artifacts.frames,
    artifacts,
    request: {
      timeoutMs: args.timeoutMs,
      deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString(),
      onlyConnections: args.onlyConnections ?? null,
      targets: args.targets ?? null,
      rules: args.rules ?? null,
      settings: args.settings ?? null,
      applyPolicy: args.applyPolicy,
      rerouteMode: args.rerouteMode ?? "onOpen",
      freeroutingPasses: args.freeroutingPasses ?? ROUTE_RUN_DEFAULT_FREEROUTING_PASSES,
      allowQualityRegression: args.allowQualityRegression ?? [],
    },
    startingPcbRevision,
    currentPcbRevision: startingPcbRevision,
    canonicalMatchesStart: true,
    progress: {
      phase: "queued",
      pass: null,
      routed: null,
      total: null,
      remaining: null,
      violations: null,
      elapsedMs: 0,
      measuredAt: createdAt,
      heartbeatAt: createdAt,
      diagnostics: [],
    },
    candidate: {
      available: false,
      identity: null,
      sha256: null,
      bytes: null,
      path: artifacts.candidate,
      reopenable: false,
      inspectedAt: null,
      limitation: null,
      diff: null,
    },
    application: {
      policy: args.applyPolicy,
      state: "not_available",
      expectedPcbRevision: startingPcbRevision,
      resultingPcbRevision: null,
      appliedAt: null,
      reason: null,
    },
    startedAt: createdAt,
    updatedAt: createdAt,
    endedAt: null,
    result: null,
    error: null,
    terminalReason: null,
  };
  await writeJson(join(runDir, "request.json"), {
    runId,
    router,
    runtimeId: ctx.services.runtimeId,
    startingPcbRevision,
    ...record.request,
  });
  ctx.services.routeRuns.start(record);
  await persistProgress(ctx, record, runDir);
  // Settles when the route worker (including auto apply) has finished, whichever way it ended.
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => (markSettled = resolve));
  const queuedState = ctx.services.routeTasks.enqueue(
    { id: runId, projectId: project.id },
    (signal) => executeRoute(args, ctx, record, snapshotDir, signal).finally(markSettled),
  );
  const startedRecord = {
    ...record,
    state: queuedState,
    status: queuedState,
    progress: { ...record.progress, phase: queuedState },
  };
  ctx.services.routeRuns.update(runId, startedRecord);
  if ((args.waitMs ?? 0) > 0 && (await waitForRun(ctx, runId, settled, args.waitMs ?? 0))) {
    const done = ctx.services.routeRuns.get(runId);
    if (done && terminalStates.has(done.state)) {
      const status = await routeStatusOutput(ctx, project, done);
      const applyNext =
        done.candidate.available && done.application.state === "manual"
          ? [{ tool: "route_apply", runId, expectedPcbRevision: done.startingPcbRevision }]
          : [];
      return {
        ...status,
        json: {
          runId,
          state: done.state,
          ...(status.json as { run: RouteRunRecord }),
          nextActions: applyNext,
        },
      };
    }
  }
  return ok(
    `Route ${runId} (${router}) ${queuedState}; computation continues independently.${fallbackReason ? ` Fallback: ${fallbackReason}.` : ""} Use route_status with this runId or route_cancel with this exact runId.`,
    {
      runId,
      state: queuedState,
      router,
      runtimeId: ctx.services.runtimeId,
      startingPcbRevision,
      requested: record.request,
      applyPolicy: args.applyPolicy,
      nextActions: [
        { tool: "route_status", runId },
        { tool: "route_cancel", runId },
      ],
    },
  );
}

export const route_status = defineTool({
  name: "route_status",
  toolset: "route",
  title: "Routing status",
  description:
    "Return persisted progress and terminal run.state (completed/failed/timed_out/cancelled), result and candidate/application state for the latest or exact runId. Includes heartbeat freshness, revision match and artifact paths.",
  inputSchema: { runId: z.string().optional() },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ runId }, ctx) => {
    const project = ctx.requireProject();
    const rec = runId
      ? ctx.services.routeRuns.get(runId)
      : ctx.services.routeRuns.latest(project.id);
    if (!rec || rec.projectId !== project.id)
      return ok("No matching route run for this project.", { run: null });
    return routeStatusOutput(ctx, project, rec);
  },
});

export const route_cancel = defineTool({
  name: "route_cancel",
  toolset: "route",
  title: "Cancel routing",
  description:
    "Idempotently request cancellation of one exact durable route run. It never cancels a different project or newer run.",
  inputSchema: { runId: z.string().min(1) },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ runId }, ctx) => {
    const project = ctx.requireProject();
    const rec = ctx.services.routeRuns.get(runId);
    if (!rec || rec.projectId !== project.id)
      throw new ToolError(`route run not found in this project: ${runId}`, "not_found");
    if (terminalStates.has(rec.state))
      return ok(`Route ${runId} is already terminal (${rec.state}); no action taken.`, {
        runId,
        state: rec.state,
        cancellation: "terminal",
      });
    const at = iso();
    const requested = {
      ...rec,
      state: "cancel_requested" as const,
      status: "cancel_requested" as const,
      updatedAt: at,
      progress: { ...rec.progress, phase: "cancel_requested", measuredAt: at },
    };
    ctx.services.routeRuns.update(runId, requested);
    const cancellation = ctx.services.routeTasks.cancel(runId);
    return ok(`Cancellation ${cancellation} for exact route ${runId}.`, {
      runId,
      state: "cancel_requested",
      cancellation,
    });
  },
});

export const route_apply = defineTool({
  name: "route_apply",
  toolset: "route",
  title: "Apply route candidate",
  description:
    "Atomically apply one validated route candidate only when the supplied expected PCB revision equals both the current board and the run's starting revision. Restores the prior board on validation failure.",
  inputSchema: {
    runId: z.string().min(1),
    expectedPcbRevision: z.string().length(64),
    allowQualityRegression: RouteRunArgs.allowQualityRegression,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ runId, expectedPcbRevision, allowQualityRegression }, ctx) => {
    const rec = ctx.services.routeRuns.get(runId);
    if (!rec) throw new ToolError(`route run not found: ${runId}`, "not_found");
    if (rec.projectId !== ctx.requireProject().id) throw new ToolError(`route ${runId} belongs to another project`, "precondition");
    if (rec.application.state === "applied" && rec.application.resultingPcbRevision)
      return ok(`Route ${runId} candidate is already applied.`, {
        runId,
        candidateIdentity: rec.candidate.identity,
        resultingPcbRevision: rec.application.resultingPcbRevision,
        state: "applied",
      });
    const applied = await applyCandidate(ctx, rec, expectedPcbRevision, allowQualityRegression);
    return ok(
      `Applied route ${runId} candidate ${applied.candidate.identity}; PCB revision is ${applied.application.resultingPcbRevision}.`,
      {
        runId,
        candidateIdentity: applied.candidate.identity,
        resultingPcbRevision: applied.application.resultingPcbRevision,
        state: applied.application.state,
      },
    );
  },
});

export const route_unroute = defineTool({
  name: "route_unroute",
  toolset: "route",
  title: "Remove routed tracks",
  description:
    "Delete routed tracks, arcs and vias from the board — all of them or only the named nets. One undo entry in KiCad.",
  inputSchema: {
    connections: z.array(z.string()).optional().describe("Net names to unroute; omit for all"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ connections }, ctx) => {
    const project = ctx.requireProject();
    const removed = await ctx.services.design.unroute(project.dir, connections);
    const what = connections?.length
      ? `${connections.length} net(s): ${connections.join(", ")}`
      : "every net";
    return ok(`Unrouted ${what}: removed ${removed.tracks} tracks and ${removed.vias} vias.`, {
      connections: connections ?? null,
      ...removed,
    });
  },
});

export const route_scope = defineTool({
  name: "route_scope",
  toolset: "route",
  title: "Nets attached to components",
  description:
    "List the nets attached to component references (e.g. the footprints a repair touches). Nets that own a copper pour are excluded by default and listed with the reason.",
  inputSchema: {
    refs: z.array(z.string().min(1)).min(1).describe('Component references, e.g. ["U701", "Q701"]'),
    excludePlaneNets: z.boolean().default(true),
    excludeNets: z.array(z.string()).optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ refs, excludePlaneNets, excludeNets }, ctx) => {
    const project = ctx.requireProject();
    const scope = await ctx.services.design.scope(project.dir, refs, {
      excludePlaneNets,
      ...(excludeNets ? { excludeNets } : {}),
    });
    const text = [
      `Scope for ${scope.components.join(", ")}${scope.missing.length ? ` (missing: ${scope.missing.join(", ")})` : ""}: ${scope.nets.length} net(s).`,
      scope.nets.length ? `Nets: ${scope.nets.join(", ")}` : "",
      scope.excluded.length
        ? `Excluded: ${scope.excluded.map((e) => `${e.net} (${e.reason})`).join("; ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(text, scope);
  },
});

export const routeTools = [route_status, route_cancel, route_apply, route_unroute, route_scope];
