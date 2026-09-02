/** Route toolset + the shared `route_run` implementation used by the core toolset. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { RouteResult, RouterWorkerMessage } from "@fabdesk/protocol";
import { PROJECT_FILES, readJsonOrNull, writeJson } from "../fs";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import type { CircuitJson } from "../services";
import { loadCircuitJson, ok, p, throwIfAborted } from "./common";

export const RouteRunArgs = {
  router: z.enum(["capacity", "freerouting"]).optional().describe("Router; defaults to the project's fabdesk.json router"),
  timeoutMs: z.number().int().min(1000).max(30 * 60_000).default(120_000),
  onlyConnections: z.array(z.string()).optional().describe("Route only these connection/net names (after route_unroute)"),
  minTraceWidth: z.number().positive().optional().describe("Minimum trace width in mm (default 0.15)"),
  settings: z.record(z.string(), z.unknown()).optional().describe("Router specific settings"),
};

export function newRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function runRoute(
  args: { router?: "capacity" | "freerouting"; timeoutMs: number; onlyConnections?: string[]; minTraceWidth?: number; settings?: Record<string, unknown> },
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
  const { srj, connectionMap } = ctx.services.tscircuit.extractSimpleRouteJson(circuitJson, {
    ...(args.minTraceWidth !== undefined ? { minTraceWidth: args.minTraceWidth } : {}),
  });
  if (srj.connections.length === 0) {
    return ok("Nothing to route: the circuit has no connections (check nets in circuit.tsx).", { runId: null, complete: [], open: [] });
  }
  const runId = newRunId();
  const runDir = p(project, PROJECT_FILES.runs, runId);
  await mkdir(runDir, { recursive: true });
  const framesPath = join(runDir, "frames.jsonl");
  await writeJson(join(runDir, "request.json"), { runId, router, source, connections: srj.connections.map((c) => c.name), onlyConnections: args.onlyConnections ?? null });

  ctx.services.routeRuns.start({ id: runId, projectId: project.id, router, framesPath, startedAt: new Date().toISOString() });

  const total = args.onlyConnections?.length ?? srj.connections.length;
  let frames = 0;
  let done = 0;
  let buffer: string[] = [];
  let flushing: Promise<void> | null = null;
  const flush = async () => {
    if (buffer.length === 0) return;
    const chunk = buffer.join("");
    buffer = [];
    await appendFile(framesPath, chunk);
  };
  const scheduleFlush = () => {
    if (flushing) return;
    flushing = new Promise<void>((r) => setTimeout(r, 50)).then(async () => {
      flushing = null;
      await flush();
    });
  };

  const onMessage = (m: RouterWorkerMessage) => {
    const ts = Date.now();
    switch (m.kind) {
      case "meta":
        buffer.push(JSON.stringify(m) + "\n");
        ctx.services.bus.emit({ ts, topic: "route.meta", meta: m });
        break;
      case "static":
        buffer.push(JSON.stringify(m) + "\n");
        ctx.services.bus.emit({ ts, topic: "route.static", static: m });
        break;
      case "frame":
        frames++;
        buffer.push(JSON.stringify(m) + "\n");
        ctx.services.bus.emit({ ts, topic: "route.frame", frame: m });
        if (m.event.kind === "connection") {
          done++;
          ctx.progress(Math.min(0.95, 0.05 + (0.9 * done) / Math.max(1, total)), `${done}/${total} connections`);
        } else if (m.event.kind === "pass-start") {
          ctx.progress(Math.min(0.95, 0.05 + (0.9 * done) / Math.max(1, total)), `pass ${m.event.passNo ?? "?"}`);
        }
        break;
      default:
        break;
    }
    scheduleFlush();
  };

  let result: RouteResult;
  try {
    throwIfAborted(ctx.signal);
    result = await ctx.services.router.route(
      {
        runId,
        router,
        srj,
        timeoutMs: args.timeoutMs,
        minFrameIntervalMs: 33,
        ...(args.onlyConnections ? { onlyConnections: args.onlyConnections } : {}),
        ...(args.settings ? { settings: args.settings } : {}),
      },
      { onMessage, signal: ctx.signal },
    );
  } catch (e) {
    await flush();
    const cancelled = ctx.signal.aborted;
    const message = e instanceof Error ? e.message : String(e);
    ctx.services.routeRuns.finish(runId, { status: cancelled ? "cancelled" : "failed", result: null, error: message });
    if (cancelled) throw new ToolError(`route ${runId} cancelled`, "cancelled");
    throw new ToolError(`router failed: ${message}`, "internal");
  }
  await flush();
  ctx.progress(0.96, "merging traces");
  const merged: CircuitJson = ctx.services.tscircuit.mergeTraces(circuitJson, result.traces, connectionMap);
  await writeJson(p(project, PROJECT_FILES.routedJson), merged);
  await writeJson(join(runDir, "result.json"), result);
  ctx.services.routeRuns.finish(runId, { status: "done", result, error: null });
  ctx.services.bus.emit({ ts: Date.now(), topic: "route.done", result });
  ctx.progress(1, "done");
  const text = [
    `Route ${runId} (${router}) ${result.timedOut ? "TIMED OUT" : "finished"} in ${Math.round(result.stats.wallMs)} ms: ${result.complete.length} complete, ${result.open.length} open, ${result.stats.vias} vias, ${result.stats.segments} segments, ${frames} frames.`,
    result.open.length ? `Open connections: ${result.open.slice(0, 30).join(", ")}${result.open.length > 30 ? ", …" : ""}` : "All connections routed.",
    `Wrote ${PROJECT_FILES.routedJson}; frames at ${PROJECT_FILES.runs}/${runId}/frames.jsonl.`,
    ...(result.detail ? [result.detail] : []),
  ].join("\n");
  return { text, json: { runId, router, complete: result.complete, open: result.open, timedOut: result.timedOut, stats: result.stats }, isError: result.open.length > 0 };
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

export const routeTools = [route_status, route_cancel, route_unroute];
