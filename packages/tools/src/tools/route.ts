/** Route toolset + the shared `route_run` implementation used by the core toolset. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { RouteResult } from "@fabdesk/protocol";
import { PROJECT_FILES, readJsonOrNull, writeJson } from "../fs";
import { FrameSink } from "../frame-sink";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import type { CircuitJson } from "../services";
import { loadCircuitJson, ok, p, throwIfAborted } from "./common";

export const RouteRunArgs = {
  router: z.enum(["capacity", "freerouting"]).optional().describe("Router; defaults to the project's fabdesk.json router"),
  timeoutMs: z.number().int().min(1000).max(30 * 60_000).default(120_000),
  onlyConnections: z.array(z.string()).optional().describe("Route only these connection/net names (after route_unroute)"),
  minTraceWidth: z.number().positive().optional().describe("Minimum trace width in mm (default: fabdesk.json board.rules.traceWidthMm, else 0.15)"),
  minFrameIntervalMs: z.number().int().min(0).max(5000).optional().describe("Minimum gap between live `attempt` frames (default 33; raise for very large boards)"),
  settings: z.record(z.string(), z.unknown()).optional().describe("Router specific settings"),
};

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** SRJ extraction options derived from the project's board settings (an import fills `rules`). */
export function srjOptionsFor(ctx: ToolContext, minTraceWidth?: number): { minTraceWidth?: number; rules?: { clearanceMm?: number; viaDrillMm?: number; viaDiameterMm?: number } } {
  const rules = ctx.project?.manifest().board.rules;
  const width = minTraceWidth ?? rules?.traceWidthMm;
  return {
    ...(width !== undefined ? { minTraceWidth: width } : {}),
    ...(rules
      ? {
          rules: {
            ...(rules.clearanceMm !== undefined ? { clearanceMm: rules.clearanceMm } : {}),
            ...(rules.viaDrillMm !== undefined ? { viaDrillMm: rules.viaDrillMm } : {}),
            ...(rules.viaDiameterMm !== undefined ? { viaDiameterMm: rules.viaDiameterMm } : {}),
          },
        }
      : {}),
  };
}

/** Large boards flood the SSE stream at 30 frames/s; scale the attempt-frame gate with the problem size. */
export function defaultFrameIntervalMs(srj: { obstacles: unknown[]; connections: unknown[] }): number {
  const size = srj.obstacles.length + srj.connections.length * 4;
  if (size > 6000) return 200;
  if (size > 2000) return 100;
  return 33;
}

export async function runRoute(
  args: { router?: "capacity" | "freerouting"; timeoutMs: number; onlyConnections?: string[]; minTraceWidth?: number; minFrameIntervalMs?: number; settings?: Record<string, unknown> },
  ctx: ToolContext,
): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const manifest = project.manifest();
  const router = args.router ?? manifest.router;
  if (router === "freerouting" && ctx.services.channel !== "internal") {
    throw new ToolError("the freerouting router is only available in internal builds; use router=capacity", "unavailable");
  }
  // Route from the routed file when re-routing a subset (keeps other traces), else from the clean build.
  const { circuitJson, source } = await loadCircuitJson(project, { preferRouted: Boolean(args.onlyConnections?.length) });
  ctx.progress(0.02, "extracting SimpleRouteJson");
  const { srj, connectionMap, copper, extractMs } = ctx.services.tscircuit.extractSimpleRouteJson(circuitJson, srjOptionsFor(ctx, args.minTraceWidth));
  if (srj.connections.length === 0) {
    return ok("Nothing to route: the circuit has no connections (check nets in circuit.tsx).", { runId: null, complete: [], open: [] });
  }
  // A prefab blank (fabdesk.json board.template) routes with the laser-prefab solver unless the caller
  // picked a preset explicitly; the adapter also switches by itself when it sees assignable vias.
  const settings: Record<string, unknown> | undefined =
    manifest.board.template !== undefined && args.settings?.["preset"] === undefined ? { ...(args.settings ?? {}), preset: "laser-prefab" } : args.settings;
  const runId = newRunId();
  const runDir = p(project, PROJECT_FILES.runs, runId);
  await mkdir(runDir, { recursive: true });
  const framesPath = join(runDir, "frames.jsonl");
  const minFrameIntervalMs = args.minFrameIntervalMs ?? defaultFrameIntervalMs(srj);
  await writeJson(join(runDir, "request.json"), {
    runId,
    router,
    source,
    connections: srj.connections.map((c) => c.name),
    onlyConnections: args.onlyConnections ?? null,
    minFrameIntervalMs,
    srj: { layerCount: srj.layerCount, layerNames: srj.layerNames ?? null, obstacles: srj.obstacles.length, copper: copper ?? null, extractMs: extractMs ?? null },
  });

  ctx.services.routeRuns.start({ id: runId, projectId: project.id, router, framesPath, startedAt: new Date().toISOString() });

  const total = args.onlyConnections?.length ?? srj.connections.length;
  let done = 0;
  const sink = new FrameSink(framesPath, ctx.services.bus, (m) => {
    if (m.kind !== "frame") return;
    if (m.event.kind === "connection") {
      done++;
      ctx.progress(Math.min(0.95, 0.05 + (0.9 * done) / Math.max(1, total)), `${Math.min(done, total)}/${total} connections${done > total ? ` (${done} connection events)` : ""}`);
    } else if (m.event.kind === "pass-start") {
      ctx.progress(Math.min(0.95, 0.05 + (0.9 * done) / Math.max(1, total)), `pass ${m.event.passNo ?? "?"}`);
    }
  });

  let result: RouteResult;
  try {
    throwIfAborted(ctx.signal);
    result = await ctx.services.router.route(
      {
        runId,
        router,
        srj,
        timeoutMs: args.timeoutMs,
        minFrameIntervalMs,
        ...(args.onlyConnections ? { onlyConnections: args.onlyConnections } : {}),
        ...(settings ? { settings } : {}),
      },
      { onMessage: sink.onMessage, signal: ctx.signal },
    );
  } catch (e) {
    await sink.close();
    const cancelled = ctx.signal.aborted;
    const message = e instanceof Error ? e.message : String(e);
    ctx.services.routeRuns.finish(runId, { status: cancelled ? "cancelled" : "failed", result: null, error: message });
    if (cancelled) throw new ToolError(`route ${runId} cancelled`, "cancelled");
    throw new ToolError(`router failed: ${message}`, "internal");
  }
  await sink.close();
  ctx.progress(0.96, "merging traces");
  const merged: CircuitJson = ctx.services.tscircuit.mergeTraces(circuitJson, result.traces, connectionMap);
  await writeJson(p(project, PROJECT_FILES.routedJson), merged);
  await writeJson(join(runDir, "result.json"), result);
  ctx.services.routeRuns.finish(runId, { status: "done", result, error: null });
  ctx.services.bus.emit({ ts: Date.now(), topic: "route.done", result });
  ctx.progress(1, "done");
  const frames = sink.stats.frames;
  const throttled = result.stats.framesThrottled;
  const viaNote = result.stats.viasOnFixed !== undefined ? ` (${result.stats.viasOnFixed} on fixed vias)` : "";
  const text = [
    `Route ${runId} (${router}${result.preset ? `, ${result.preset}` : ""}) ${result.timedOut ? "TIMED OUT" : "finished"} in ${Math.round(result.stats.wallMs)} ms: ${result.complete.length} complete, ${result.open.length} open, ${result.stats.vias} vias${viaNote}, ${result.stats.segments} segments, ${frames} frames${throttled ? ` (${throttled} attempt frames throttled at ${minFrameIntervalMs} ms)` : ""}.`,
    result.open.length ? `Open connections: ${result.open.slice(0, 30).join(", ")}${result.open.length > 30 ? ", …" : ""}` : "All connections routed.",
    `Wrote ${PROJECT_FILES.routedJson}; frames at ${PROJECT_FILES.runs}/${runId}/frames.jsonl.`,
    ...(result.detail ? [result.detail] : []),
  ].join("\n");
  return {
    text,
    json: { runId, router, ...(result.preset ? { preset: result.preset } : {}), complete: result.complete, open: result.open, timedOut: result.timedOut, stats: result.stats, frames },
    isError: result.open.length > 0,
  };
}

export const route_status = defineTool({
  name: "route_status",
  toolset: "route",
  title: "Routing status",
  description: "Status of a route run (default: the latest for the project): running/done/failed, completed and open connections, statistics and the frames file path.",
  inputSchema: { runId: z.string().optional() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ runId }, ctx) => {
    const project = ctx.requireProject();
    const rec = runId ? ctx.services.routeRuns.get(runId) : ctx.services.routeRuns.latest(project.id);
    if (!rec) return ok("No route runs for this project yet. Call route_run.", { run: null });
    const r = rec.result;
    const text = `Run ${rec.id} (${rec.router}): ${rec.status}${r ? ` — ${r.complete.length} complete, ${r.open.length} open, ${r.stats.vias} vias, ${r.stats.segments} segments${r.timedOut ? ", timed out" : ""}` : ""}${rec.error ? ` — ${rec.error}` : ""}`;
    return ok(text, { run: rec });
  },
});

export const route_cancel = defineTool({
  name: "route_cancel",
  toolset: "route",
  title: "Cancel routing",
  description: "Cancel the running route job (terminates the router worker). Partial traces are discarded; circuit.routed.json is left untouched.",
  inputSchema: { runId: z.string().optional() },
  annotations: { idempotentHint: true },
  handler: async ({ runId }, ctx) => {
    ctx.services.router.cancel(runId);
    return ok(runId ? `Cancel requested for ${runId}.` : "Cancel requested for the active route run.", { runId: runId ?? null });
  },
});

export const route_unroute = defineTool({
  name: "route_unroute",
  toolset: "route",
  title: "Remove routed traces",
  description:
    "Remove routed traces/vias from circuit.routed.json, either all of them or only the named connections, so they can be rerouted with route_run {onlyConnections}. Deletes circuit.routed.json entirely when everything is unrouted.",
  inputSchema: {
    connections: z.array(z.string()).optional().describe("Connection/net names to unroute; omit for all"),
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: async ({ connections }, ctx) => {
    const project = ctx.requireProject();
    const routedPath = p(project, PROJECT_FILES.routedJson);
    const routed = await readJsonOrNull<CircuitJson>(routedPath);
    if (!routed) return ok("Nothing routed yet.", { removed: 0 });
    if (!connections || connections.length === 0) {
      await Bun.file(routedPath).delete();
      return ok("Removed all routing (deleted circuit.routed.json).", { removedAll: true });
    }
    const next = ctx.services.tscircuit.unrouteCircuit(routed, connections);
    await writeJson(routedPath, next);
    return ok(`Unrouted ${connections.length} connection(s): ${connections.join(", ")}. Re-run route_run with onlyConnections.`, { connections });
  },
});

export const route_scope = defineTool({
  name: "route_scope",
  toolset: "route",
  title: "Connections attached to components",
  description:
    "List the connections and nets attached to component references (e.g. the footprints a repair touches) so they can be unrouted and re-routed with route_run {onlyConnections}. Nets that own a copper pour are excluded by default and listed with the reason.",
  inputSchema: {
    refs: z.array(z.string().min(1)).min(1).describe("Component references, e.g. [\"U701\", \"Q701\"]"),
    excludePlaneNets: z.boolean().default(true),
    excludeNets: z.array(z.string()).optional(),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async ({ refs, excludePlaneNets, excludeNets }, ctx) => {
    const project = ctx.requireProject();
    const { circuitJson, source } = await loadCircuitJson(project);
    const scope = ctx.services.tscircuit.connectionsForComponents(circuitJson, refs, { excludePlaneNets, ...(excludeNets ? { excludeNets } : {}) });
    const text = [
      `Scope for ${scope.components.join(", ")}${scope.missing.length ? ` (missing: ${scope.missing.join(", ")})` : ""} from ${source}: ${scope.connections.length} connection(s), ${scope.nets.length} net(s).`,
      scope.nets.length ? `Nets: ${scope.nets.join(", ")}` : "",
      scope.excluded.length ? `Excluded: ${scope.excluded.map((e) => `${e.net} (${e.reason})`).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return ok(text, { ...scope, source });
  },
});

export const routeTools = [route_status, route_cancel, route_unroute, route_scope];
