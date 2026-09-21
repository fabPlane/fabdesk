/** Route toolset + the shared `route_run` implementation used by the core toolset. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { CinemaShape, RouteResult } from "@fabdesk/protocol";
import { PROJECT_FILES, writeAtomic, writeJson } from "../fs";
import { FrameSink } from "../frame-sink";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import type { RouteProgress, RouteRunRecord } from "../services";
import { ok, p, throwIfAborted } from "./common";
import { rowPoints } from "./spatial";

export const RouteRunArgs = {
  router: z
    .enum(["capacity", "freerouting"])
    .optional()
    .describe("Router; defaults to the project's fabdesk.json router"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 60_000)
    .default(120_000),
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
    .describe("Selected nets or exact remaining endpoint pairs"),
  rules: z
    .object({
      widthMm: z.number().positive().optional(),
      clearanceMm: z.number().nonnegative().optional(),
      viaDiameterMm: z.number().positive().optional(),
      viaDrillMm: z.number().positive().optional(),
      refillZones: z.boolean().optional(),
    })
    .optional()
    .describe(
      "Explicit routing width, clearance, via and zone rules; the router uses the board's enabled copper layers",
    ),
  settings: z.record(z.string(), z.unknown()).optional().describe("Router specific settings"),
  applyPolicy: z
    .enum(["auto", "manual"])
    .default("auto")
    .describe(
      "auto applies only if the starting PCB revision is still current; manual preserves a candidate for route_apply",
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
  router?: "capacity" | "freerouting";
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
  };
  settings?: Record<string, unknown>;
  applyPolicy: "auto" | "manual";
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
    "nets",
    "tracks",
    "vias",
    "zones",
    "keepouts",
    "texts",
    "unrouted",
  ] as const;
  const values = await Promise.all(selects.map((select) => ctx.services.design.query(dir, select)));
  return Object.fromEntries(
    selects.map((select, index) => [select, stableRows(values[index]!)]),
  ) as Record<(typeof selects)[number], string[]>;
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

async function persistProgress(ctx: ToolContext, rec: RouteRunRecord, runDir: string) {
  ctx.services.routeRuns.update(rec.id, rec);
  await writeJson(join(runDir, "progress.json"), compactRecord(rec));
}

async function applyCandidate(
  ctx: ToolContext,
  rec: RouteRunRecord,
  expectedRevision: string,
): Promise<RouteRunRecord> {
  const project = ctx.requireProject();
  if (rec.projectId !== project.id)
    throw new ToolError(`route ${rec.id} belongs to another project`, "precondition");
  if (!rec.candidate.available || !rec.candidate.reopenable)
    throw new ToolError(`route ${rec.id} has no validated candidate`, "precondition");
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
    await ctx.services.design.release(project.dir).catch(() => undefined);
    const check = sha256(await readFile(boardPath));
    if (check !== current)
      throw new ToolError(`PCB changed before atomic replace: ${check}`, "precondition");
    await writeAtomic(boardPath, candidate);
    await ctx.services.design.release(project.dir).catch(() => undefined);
    await ctx.services.design.query(project.dir, "nets");
    const resulting = sha256(await readFile(boardPath));
    if (resulting !== rec.candidate.sha256)
      throw new Error(
        `reopened board hash ${resulting} differs from candidate ${rec.candidate.sha256}`,
      );
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
  const frames = new RouteProgressFrames(rec.id, started, sink);
  let progressWrites = Promise.resolve();
  let cancelPromise: Promise<void> | null = null;
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
    const endpoints = await ctx.services.design.query(snapshotDir, "unrouted");
    const requestedNets = [
      ...new Set([
        ...(args.onlyConnections ?? []),
        ...(args.targets ?? []).map((target) => target.net),
      ]),
    ];
    const endpointNets = new Set(endpoints.map((row) => String(row["net"] ?? "")));
    const missing = requestedNets.filter((net) => !endpointNets.has(net));
    if (missing.length)
      throw new ToolError(`no remaining endpoints for ${missing.join(", ")}`, "precondition");
    const ruleSettings: Record<string, unknown> = {
      ...(args.settings ?? {}),
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
    const summary = await ctx.services.design.route(
      snapshotDir,
      {
        router: rec.router as "capacity" | "freerouting",
        maxTimeMs: args.timeoutMs,
        ...(requestedNets.length ? { nets: requestedNets } : {}),
        ...(Object.keys(ruleSettings).length ? { settings: ruleSettings } : {}),
        ...(args.rules?.refillZones !== undefined ? { refillZones: args.rules.refillZones } : {}),
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
              pass: value.pass ?? null,
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
          ctx.services.routeRuns.update(rec.id, rec);
          progressWrites = progressWrites.then(() =>
            writeJson(join(runDir, "progress.json"), compactRecord(rec)),
          );
        },
      },
    );
    await progressWrites;
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
    const fullResult: RouteResult = {
      runId: rec.id,
      router: rec.router as "capacity" | "freerouting",
      complete: [],
      open,
      timedOut: summary.timedOut,
      state: resultState,
      remainingEndpoints: summary.unrouted,
      obstacles,
      changedGeometry: geometry,
      nextActions:
        resultState === "complete"
          ? []
          : ["inspect route candidate", "inspect remaining connectivity"],
      stats: {
        vias: summary.vias,
        segments: summary.tracks,
        wallMs: summary.wallMs,
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
    await writeJson(join(runDir, "result.json"), { ...fullResult, summary });
    await writeAtomic(join(runDir, "router.log"), `${summary.log.join("\n")}\n`);
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
    const usableCandidate = resultState !== "no-progress";
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
            : args.applyPolicy === "manual"
              ? "manual"
              : "pending",
        reason: forbidden.length
          ? `forbidden candidate deltas: ${forbidden.join(", ")}`
          : !usableCandidate
            ? "no usable route progress"
            : null,
      },
    };
    await persistProgress(ctx, rec, runDir);
    if (!forbidden.length && usableCandidate && args.applyPolicy === "auto") {
      try {
        rec = await applyCandidate(ctx, rec, rec.startingPcbRevision);
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
    ctx.services.bus.emit({ ts: Date.now(), topic: "route.done", result: fullResult });
  } catch (error) {
    await cancelPromise;
    await sink.close().catch(() => undefined);
    const endedAt = iso();
    const cancelled = signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    const canonical = sha256(await readFile(p(project, PROJECT_FILES.boardPcb)));
    rec = {
      ...rec,
      state: cancelled ? "cancelled" : "failed",
      status: cancelled ? "cancelled" : "failed",
      endedAt,
      updatedAt: endedAt,
      error: message,
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

export async function runRoute(args: RouteArgs, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const router = args.router ?? project.manifest().router;
  if (router === "freerouting" && ctx.services.channel !== "internal")
    return {
      text: "Routing unavailable: freerouting is not present in this packaged runtime.",
      json: { state: "unavailable", router },
      isError: true,
    };
  const boardPath = p(project, PROJECT_FILES.boardPcb);
  const boardBytes = await readFile(boardPath).catch(() => {
    throw new ToolError("board.kicad_pcb does not exist; build the board first", "precondition");
  });
  const projectBytes = await readFile(p(project, PROJECT_FILES.boardPro)).catch(
    () => new Uint8Array(),
  );
  const startingPcbRevision = sha256(boardBytes);
  const runId = newRunId();
  const runRel = join(PROJECT_FILES.runs, runId);
  const runDir = p(project, runRel);
  const snapshotDir = join(runDir, "snapshot");
  await mkdir(snapshotDir, { recursive: true });
  await Promise.all([
    writeAtomic(join(snapshotDir, PROJECT_FILES.boardPcb), boardBytes),
    writeAtomic(join(snapshotDir, PROJECT_FILES.boardPro), projectBytes),
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
  await writeJson(join(runDir, "progress.json"), record);
  ctx.services.routeRuns.start(record);
  const queuedState = ctx.services.routeTasks.enqueue(
    { id: runId, projectId: project.id },
    (signal) => executeRoute(args, ctx, record, snapshotDir, signal),
  );
  const startedRecord = {
    ...record,
    state: queuedState,
    status: queuedState,
    progress: { ...record.progress, phase: queuedState },
  };
  ctx.services.routeRuns.update(runId, startedRecord);
  return ok(
    `Route ${runId} ${queuedState}; computation continues independently. Use route_status with this runId or route_cancel with this exact runId.`,
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
    "Return compact persisted progress, heartbeat freshness, revision match, candidate/application state and artifact paths for the latest or exact durable route run.",
  inputSchema: { runId: z.string().optional() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ runId }, ctx) => {
    const project = ctx.requireProject();
    const rec = runId
      ? ctx.services.routeRuns.get(runId)
      : ctx.services.routeRuns.latest(project.id);
    if (!rec || rec.projectId !== project.id)
      return ok("No matching route run for this project.", { run: null });
    const current = sha256(await readFile(p(project, PROJECT_FILES.boardPcb)));
    const run = {
      ...rec,
      currentPcbRevision: current,
      canonicalMatchesStart: current === rec.startingPcbRevision,
      heartbeatFreshnessMs: Date.now() - Date.parse(rec.progress.heartbeatAt),
    };
    ctx.services.routeRuns.update(rec.id, run);
    return ok(
      `Run ${rec.id} (${rec.router}): ${rec.state}; ${rec.progress.routed ?? "?"}/${rec.progress.total ?? "?"} routed; candidate ${rec.candidate.available ? "ready" : "unavailable"}; apply ${rec.application.state}.`,
      { run },
    );
  },
});

export const route_cancel = defineTool({
  name: "route_cancel",
  toolset: "route",
  title: "Cancel routing",
  description:
    "Idempotently request cancellation of one exact durable route run. It never cancels a different project or newer run.",
  inputSchema: { runId: z.string().min(1) },
  annotations: { idempotentHint: true },
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
  inputSchema: { runId: z.string().min(1), expectedPcbRevision: z.string().length(64) },
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: async ({ runId, expectedPcbRevision }, ctx) => {
    const rec = ctx.services.routeRuns.get(runId);
    if (!rec) throw new ToolError(`route run not found: ${runId}`, "not_found");
    if (rec.application.state === "applied" && rec.application.resultingPcbRevision)
      return ok(`Route ${runId} candidate is already applied.`, {
        runId,
        candidateIdentity: rec.candidate.identity,
        resultingPcbRevision: rec.application.resultingPcbRevision,
        state: "applied",
      });
    const applied = await applyCandidate(ctx, rec, expectedPcbRevision);
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
  annotations: { destructiveHint: true, idempotentHint: true },
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
  annotations: { readOnlyHint: true, idempotentHint: true },
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
