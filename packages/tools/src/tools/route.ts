/** Route toolset + the shared `route_run` implementation used by the core toolset. */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { RouteResult } from "@fabdesk/protocol";
import { PROJECT_FILES, writeJson } from "../fs";
import { FrameSink } from "../frame-sink";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import type { RouteProgress } from "../services";
import { loadNetlist, ok, p, throwIfAborted } from "./common";

export const RouteRunArgs = {
  router: z.enum(["capacity", "freerouting"]).optional().describe("Router; defaults to the project's fabdesk.json router"),
  timeoutMs: z.number().int().min(1000).max(30 * 60_000).default(120_000),
  onlyConnections: z.array(z.string()).optional().describe("Route only these nets (after route_unroute)"),
  settings: z.record(z.string(), z.unknown()).optional().describe("Router specific settings"),
};

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turns the route job's progress into cinema frames: a `pass-start` when the pass changes and a
 * `connection` per newly routed connection. The job streams no geometry, so `shapes` stays empty.
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
    const pass = pr.pass ?? (pr.phase ? Number(/pass\s+(\d+)/i.exec(pr.phase)?.[1]) || undefined : undefined);
    if (pass !== undefined && pass !== this.pass) {
      this.pass = pass;
      this.sink.onMessage({ kind: "frame", runId: this.runId, seq: this.seq++, elapsedMs, event: { kind: "pass-start", passNo: pass }, shapes: [] });
    }
    if (pr.routed !== undefined && pr.routed > this.routed) {
      for (let n = this.routed; n < pr.routed; n++) {
        this.sink.onMessage({ kind: "frame", runId: this.runId, seq: this.seq++, elapsedMs, event: { kind: "connection", netNumber: n + 1, ...(pr.phase ? { status: pr.phase } : {}) }, shapes: [] });
      }
      this.routed = pr.routed;
    } else if (pr.message || (pr.pass === undefined && pr.routed === undefined && pr.phase)) {
      // The JS router reports only a solver phase and a percentage (no passes, no routed count);
      // without this the cinema sat on "waiting for frames…" for the whole run.
      const status = pr.message ?? `${pr.phase}${pr.percent !== undefined ? ` · ${pr.percent}%` : ""}`;
      if (status && status !== this.lastStatus) {
        this.lastStatus = status;
        this.sink.onMessage({ kind: "frame", runId: this.runId, seq: this.seq++, elapsedMs, event: { kind: "attempt", status }, shapes: [] });
      }
    }
  }
}

export async function runRoute(
  args: { router?: "capacity" | "freerouting"; timeoutMs: number; onlyConnections?: string[]; settings?: Record<string, unknown> },
  ctx: ToolContext,
): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const manifest = project.manifest();
  const router = args.router ?? manifest.router;
  if (router === "freerouting" && ctx.services.channel !== "internal") {
    throw new ToolError("the freerouting router is only available in internal builds; use router=capacity", "unavailable");
  }
  // A prefab blank (fabdesk.json board.template) routes with the laser-prefab preset unless the caller
  // picked one explicitly; the bridge's JS router also switches by itself when the board has free vias.
  const settings: Record<string, unknown> | undefined =
    manifest.board.template !== undefined && args.settings?.["preset"] === undefined ? { ...(args.settings ?? {}), preset: "laser-prefab" } : args.settings;
  const runId = newRunId();
  const runDir = p(project, PROJECT_FILES.runs, runId);
  await mkdir(runDir, { recursive: true });
  const framesPath = join(runDir, "frames.jsonl");
  await writeJson(join(runDir, "request.json"), { runId, router, onlyConnections: args.onlyConnections ?? null, timeoutMs: args.timeoutMs });
  // Keep the persisted reference portable when the projects root moves. FrameSink still writes to
  // the absolute path above; the core resolves this relative path against the current project.
  ctx.services.routeRuns.start({ id: runId, projectId: project.id, router, framesPath: join(PROJECT_FILES.runs, runId, "frames.jsonl"), startedAt: new Date().toISOString() });

  const started = Date.now();
  const sink = new FrameSink(framesPath, ctx.services.bus);
  const board = manifest.board;
  // The outline the build drew comes from the netlist's board spec; the manifest is the fallback.
  const spec = (await loadNetlist(project).catch(() => null))?.board;
  sink.onMessage({
    kind: "meta",
    runId,
    router,
    bounds: { x1: 0, y1: 0, x2: spec?.widthMm ?? board.widthMm ?? 0, y2: spec?.heightMm ?? board.heightMm ?? 0 },
    layers: Array.from({ length: board.layers }, (_, i) => (i === 0 ? "F.Cu" : i === board.layers - 1 ? "B.Cu" : `In${i}.Cu`)),
    unitsPerMm: 1,
  });
  const frames = new RouteProgressFrames(runId, started, sink);
  let total = args.onlyConnections?.length ?? 0;

  let summary;
  try {
    throwIfAborted(ctx.signal);
    summary = await ctx.services.design.route(
      project.dir,
      { router, maxTimeMs: args.timeoutMs, ...(args.onlyConnections ? { nets: args.onlyConnections } : {}), ...(settings ? { settings } : {}) },
      {
        signal: ctx.signal,
        onProgress: (pr) => {
          if (pr.total) total = pr.total;
          frames.onProgress(pr);
          const routed = pr.routed ?? 0;
          ctx.progress(Math.min(0.95, 0.05 + (total ? (0.9 * routed) / total : 0)), pr.message ?? pr.phase ?? pr.state);
        },
      },
    );
  } catch (e) {
    await sink.close();
    const cancelled = ctx.signal.aborted;
    const message = e instanceof Error ? e.message : String(e);
    ctx.services.routeRuns.finish(runId, { status: cancelled ? "cancelled" : "failed", result: null, error: message });
    if (cancelled) throw new ToolError(`route ${runId} cancelled`, "cancelled");
    throw new ToolError(`router failed: ${message}`, "internal");
  }
  const open = [...new Set(summary.unrouted.map((u) => u.net))];
  const result: RouteResult = {
    runId,
    router,
    complete: [],
    open,
    timedOut: summary.timedOut,
    stats: { vias: summary.vias, segments: summary.tracks, wallMs: summary.wallMs, frames: sink.stats.frames, viasOnFixed: summary.claimedVias },
    ...(summary.preset ? { preset: summary.preset } : {}),
    ...(summary.message ? { detail: summary.message } : {}),
  };
  // Routing mutates board.kicad_pcb, so any earlier stats artifact is stale. Refresh it when KiCad
  // is available; otherwise remove it rather than presenting old measurements as current.
  const statsPath = p(project, PROJECT_FILES.reports, "stats.json");
  await rm(statsPath, { force: true });
  const cli = await ctx.services.kicad.resolveCli();
  if (cli) {
    await ctx.services.kicad
      .boardStats(cli, { board: p(project, PROJECT_FILES.boardPcb), scratchFile: statsPath })
      .catch(() => {});
  }
  sink.onMessage({ kind: "result", runId, result });
  await sink.close();
  await writeJson(join(runDir, "result.json"), { ...result, summary });
  ctx.services.routeRuns.finish(runId, { status: "done", result, error: null });
  ctx.services.bus.emit({ ts: Date.now(), topic: "route.done", result });
  ctx.progress(1, "done");
  const viaNote = summary.claimedVias || summary.preset === "laser-prefab" ? ` (${summary.claimedVias} factory vias claimed${summary.preset === "laser-prefab" && summary.vias ? `, ${summary.vias} OFF the blank` : ""})` : "";
  const text = [
    `Route ${runId} (${router}${summary.preset ? `, ${summary.preset}` : ""}) ${summary.timedOut ? "TIMED OUT" : "finished"} in ${Math.round(summary.wallMs)} ms: ${summary.routed}/${summary.total} connections routed, ${summary.vias} vias${viaNote}, ${summary.tracks} tracks.`,
    open.length ? `Open nets: ${open.slice(0, 30).join(", ")}${open.length > 30 ? ", …" : ""}` : "All connections routed.",
    `Applied to board.kicad_pcb as "${summary.message}"; frames at ${PROJECT_FILES.runs}/${runId}/frames.jsonl.`,
  ].join("\n");
  return {
    text,
    json: { runId, router, ...(summary.preset ? { preset: summary.preset } : {}), routed: summary.routed, total: summary.total, open, timedOut: summary.timedOut, claimedVias: summary.claimedVias, stats: result.stats },
    isError: open.length > 0 || (summary.preset === "laser-prefab" && summary.vias > 0),
  };
}

export const route_status = defineTool({
  name: "route_status",
  toolset: "route",
  title: "Routing status",
  description: "Status of a route run (default: the latest for the project): running/done/failed, open nets, statistics and the frames file path.",
  inputSchema: { runId: z.string().optional() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ runId }, ctx) => {
    const project = ctx.requireProject();
    const rec = runId ? ctx.services.routeRuns.get(runId) : ctx.services.routeRuns.latest(project.id);
    if (!rec) return ok("No route runs for this project yet. Call route_run.", { run: null });
    const r = rec.result;
    const text = `Run ${rec.id} (${rec.router}): ${rec.status}${r ? ` — ${r.open.length} open, ${r.stats.vias} vias, ${r.stats.segments} tracks${r.timedOut ? ", timed out" : ""}` : ""}${rec.error ? ` — ${rec.error}` : ""}`;
    return ok(text, { run: rec });
  },
});

export const route_cancel = defineTool({
  name: "route_cancel",
  toolset: "route",
  title: "Cancel routing",
  description: "Cancel the running route job on the design server. The job stops between steps; nothing is applied to the board.",
  inputSchema: {},
  annotations: { idempotentHint: true },
  handler: async (_args, ctx) => {
    await ctx.services.design.cancelRoute(ctx.project?.dir);
    return ok("Cancel requested for the active route job.", {});
  },
});

export const route_unroute = defineTool({
  name: "route_unroute",
  toolset: "route",
  title: "Remove routed tracks",
  description: "Delete routed tracks, arcs and vias from the board — all of them or only the named nets — so they can be rerouted with route_run {onlyConnections}. One undo entry in KiCad.",
  inputSchema: {
    connections: z.array(z.string()).optional().describe("Net names to unroute; omit for all"),
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: async ({ connections }, ctx) => {
    const project = ctx.requireProject();
    const removed = await ctx.services.design.unroute(project.dir, connections);
    const what = connections?.length ? `${connections.length} net(s): ${connections.join(", ")}` : "every net";
    return ok(`Unrouted ${what}: removed ${removed.tracks} tracks and ${removed.vias} vias. Re-run route_run${connections?.length ? " with onlyConnections" : ""}.`, { connections: connections ?? null, ...removed });
  },
});

export const route_scope = defineTool({
  name: "route_scope",
  toolset: "route",
  title: "Nets attached to components",
  description:
    "List the nets attached to component references (e.g. the footprints a repair touches) so they can be unrouted and re-routed with route_run {onlyConnections}. Nets that own a copper pour are excluded by default and listed with the reason.",
  inputSchema: {
    refs: z.array(z.string().min(1)).min(1).describe('Component references, e.g. ["U701", "Q701"]'),
    excludePlaneNets: z.boolean().default(true),
    excludeNets: z.array(z.string()).optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ refs, excludePlaneNets, excludeNets }, ctx) => {
    const project = ctx.requireProject();
    const scope = await ctx.services.design.scope(project.dir, refs, { excludePlaneNets, ...(excludeNets ? { excludeNets } : {}) });
    const text = [
      `Scope for ${scope.components.join(", ")}${scope.missing.length ? ` (missing: ${scope.missing.join(", ")})` : ""}: ${scope.nets.length} net(s).`,
      scope.nets.length ? `Nets: ${scope.nets.join(", ")}` : "",
      scope.excluded.length ? `Excluded: ${scope.excluded.map((e) => `${e.net} (${e.reason})`).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(text, scope);
  },
});

export const routeTools = [route_status, route_cancel, route_unroute, route_scope];
