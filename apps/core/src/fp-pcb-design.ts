/**
 * `DesignService` on a FabPlane PCB bridge: the netlist is compiled by the bridge's compile job,
 * routing by its route job, and everything else (queries, unroute, scope, library search) goes
 * through the typed client on the project's session. Positions come back in millimetres; the
 * client speaks nanometres.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KiCadObjectType } from "@fp-pcb/proto";
import { toMm, type Board, type KiCad } from "@fp-pcb/client";
import type { FpPcbCompileJob, FpPcbDiagnostic, FpPcbRouteJob } from "@fabdesk/protocol";
import {
  PROJECT_FILES,
  ToolError,
  type BuildError,
  type BuildOptions,
  type BuildResult,
  type ComponentScope,
  type DesignRow,
  type DesignSelect,
  type DesignService,
  type DesignStatus,
  type FootprintHit,
  type RouteJobOptions,
  type RouteProgress,
  type RouteSummary,
} from "@fabdesk/tools";
import type { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { BOARD_PRO, type FpPcbSessions } from "./fp-pcb-session";

/** The `@fp-pcb/compile` frontend that reads `circuit.netlist.json` (its `NETLIST_JSON_KIND`). */
export const NETLIST_JSON_KIND = "netlist-json";

const STAGE_FRACTION: Record<string, number> = { queued: 0.05, frontend: 0.1, validating: 0.15, checking: 0.25, outlining: 0.35, importing: 0.5, placing: 0.7, saving: 0.85 };
const mm = (nm: number) => Math.round(toMm(nm) * 1000) / 1000;

function toBuildError(d: FpPcbDiagnostic): BuildError {
  return {
    message: d.message,
    type: d.code ?? d.stage,
    ...(d.file ? { file: d.file } : {}),
    ...(d.line !== undefined ? { line: d.line } : {}),
    ...(d.column !== undefined ? { column: d.column } : {}),
  };
}

export function toRouteProgress(job: FpPcbRouteJob): RouteProgress {
  const p = job.progress;
  return {
    state: job.state,
    log: job.log,
    ...(p?.phase ? { phase: p.phase } : {}),
    ...(p?.message ? { message: p.message } : {}),
    ...(p?.pass !== undefined ? { pass: p.pass } : {}),
    ...(p?.routed !== undefined ? { routed: p.routed } : {}),
    ...(p?.total !== undefined ? { total: p.total } : {}),
  };
}

export type FpPcbDesignDeps = {
  bridge: () => FpPcbBridgeClient;
  sessions: FpPcbSessions;
  readText?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
};

export function createFpPcbDesign(deps: FpPcbDesignDeps): DesignService {
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const exists = deps.exists ?? ((p: string) => Bun.file(p).exists());
  const active = new Map<string, string>(); // projectDir -> session id with a running route

  const build = async (opts: BuildOptions): Promise<BuildResult> => {
    const started = performance.now();
    const entrypoint = opts.entrypoint ?? PROJECT_FILES.netlistJson;
    const entryPath = join(opts.projectDir, entrypoint);
    if (!(await exists(entryPath))) {
      return { ok: false, errors: [{ type: "missing_entrypoint", message: `${entrypoint} not found in ${opts.projectDir}`, file: entrypoint }], warnings: [], counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 }, durationMs: 0 };
    }
    const source = { kind: NETLIST_JSON_KIND, files: { [entrypoint]: await readText(entryPath) }, entrypoint };
    opts.progress?.(0.05, "session");
    const job = await deps.sessions.withRetry(opts.projectDir, (s) =>
      deps.bridge().compile(
        s.id,
        { source, ...(s.path ? {} : { project: { path: join(opts.projectDir, BOARD_PRO) } }), autoplace: true, save: true, netlistPath: PROJECT_FILES.compileNet },
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (j: FpPcbCompileJob) => opts.progress?.(STAGE_FRACTION[j.state] ?? 0.5, j.state),
        },
      ),
    );
    // The project may have been created by this job: the session now has a board and a path.
    if (job.state === "cancelled") throw new ToolError("compile cancelled", "cancelled");
    const durationMs = Math.round(performance.now() - started);
    const empty = { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 };
    if (!job.result) return { ok: false, errors: [{ type: "compile_job_failed", message: job.error ?? `compile job ${job.id} ended in state ${job.state} with no result` }], warnings: [], counts: empty, durationMs };
    const errors = job.result.diagnostics.filter((d) => d.severity === "error").map(toBuildError);
    const warnings = job.result.diagnostics.filter((d) => d.severity === "warning").map(toBuildError);
    return { ok: job.result.ok && errors.length === 0, errors, warnings, counts: job.result.counts, durationMs, ...(job.revision !== undefined ? { revision: job.revision } : {}) };
  };

  const query = async (projectDir: string, select: DesignSelect, filter?: string): Promise<DesignRow[]> => {
    const board = await deps.sessions.board(projectDir);
    const f = filter?.toLowerCase();
    const keep = (...fields: unknown[]) => !f || fields.some((v) => String(v ?? "").toLowerCase().includes(f));
    switch (select) {
      case "components": {
        return (await board.getFootprints())
          .map((fp) => ({ ref: fp.reference, value: fp.value, footprint: fp.libraryId, x: mm(fp.position.x), y: mm(fp.position.y), layer: fp.layerId }))
          .filter((r) => keep(r.ref, r.value, r.footprint));
      }
      case "nets": {
        const pads = await board.getPads();
        const counts = new Map<string, number>();
        for (const pad of pads) {
          const net = pad.net ?? "";
          if (net) counts.set(net, (counts.get(net) ?? 0) + 1);
        }
        return (await board.nets()).map((n) => ({ name: n.name, code: n.code, pads: counts.get(n.name) ?? 0 })).filter((r) => keep(r.name));
      }
      case "pads": {
        const refs = new Map((await board.getFootprints()).map((fp) => [fp.id, fp.reference]));
        return (await board.getPads())
          .map((pad) => ({ component: refs.get(pad.parent ?? "") ?? pad.parent ?? "", number: pad.number, net: pad.net ?? "", x: mm(pad.position.x), y: mm(pad.position.y) }))
          .filter((r) => keep(r.component, r.net, r.number));
      }
      case "tracks": {
        return (await board.getTracks())
          .map((t) => ({ kind: t.typeName.replace(/^.*\./, ""), net: t.net ?? "", layer: t.layerId ?? "", id: t.id }))
          .filter((r) => keep(r.net));
      }
      case "unrouted": {
        return (await board.ratsnest()).edges
          .map((e) => ({ net: e.net, from: `${mm(e.sourcePosition.x)},${mm(e.sourcePosition.y)}`, to: `${mm(e.targetPosition.x)},${mm(e.targetPosition.y)}` }))
          .filter((r) => keep(r.net));
      }
    }
  };

  const route = async (projectDir: string, opts: RouteJobOptions, hooks: { onProgress?: (p: RouteProgress) => void; signal?: AbortSignal }): Promise<RouteSummary> => {
    await deps.sessions.board(projectDir); // fails early with a precondition when nothing is built
    const job = await deps.sessions.withRetry(projectDir, async (s) => {
      active.set(projectDir, s.id);
      try {
        return await deps.bridge().route(
          s.id,
          {
            router: opts.router === "freerouting" ? "freerouting" : "js",
            options: { ...(opts.nets ? { nets: opts.nets } : {}), ...(opts.maxTimeMs ? { maxTimeMs: opts.maxTimeMs } : {}), ...(opts.settings ?? {}) },
            ...(opts.refillZones !== undefined ? { refillZones: opts.refillZones } : {}),
          },
          { ...(hooks.signal ? { signal: hooks.signal } : {}), maxMs: (opts.maxTimeMs ?? 120_000) + 5 * 60_000, onProgress: (j) => hooks.onProgress?.(toRouteProgress(j)) },
        );
      } finally {
        active.delete(projectDir);
      }
    });
    if (job.state === "cancelled") throw new ToolError("route cancelled", "cancelled");
    if (job.state === "failed" || !job.summary) throw new ToolError(job.error ?? `route job ${job.id} ended in state ${job.state}`, "internal");
    const s = job.summary;
    return { tracks: s.tracks, vias: s.vias, routed: s.routed, total: s.total, trackLengthNm: s.trackLengthNm, elapsedMs: s.elapsedMs, wallMs: s.wallMs, timedOut: s.timedOut, message: s.message, unrouted: s.unrouted.map((u) => ({ net: u.net, from: { x: mm(u.from.x), y: mm(u.from.y) }, to: { x: mm(u.to.x), y: mm(u.to.y) } })), log: s.log };
  };

  const cancelRoute = async (projectDir?: string): Promise<void> => {
    const ids = projectDir ? [active.get(projectDir)].filter((v): v is string => !!v) : [...active.values()];
    for (const id of ids) await deps.bridge().cancelJobs("route", id).catch(() => 0);
  };

  const unroute = async (projectDir: string, nets?: string[]): Promise<{ tracks: number; vias: number }> => {
    const board = await deps.sessions.board(projectDir);
    const wanted = nets?.length ? new Set(nets) : null;
    const items = (await board.getTracks()).filter((t) => !wanted || wanted.has(t.net ?? ""));
    const vias = items.filter((t) => t.typeName.endsWith("Via")).length;
    if (items.length) await board.commit(wanted ? `Unroute ${[...wanted].join(", ")}` : "Unroute all", (tx) => tx.delete(items));
    return { tracks: items.length - vias, vias };
  };

  const scope = async (projectDir: string, refs: string[], opts: { excludePlaneNets?: boolean; excludeNets?: string[] } = {}): Promise<ComponentScope> => {
    const board = await deps.sessions.board(projectDir);
    const footprints = await board.getFootprints();
    const byRef = new Map(footprints.map((fp) => [fp.reference, fp.id]));
    const components = refs.filter((r) => byRef.has(r));
    const missing = refs.filter((r) => !byRef.has(r));
    const ids = new Set(components.map((r) => byRef.get(r)!));
    const pads: Record<string, number> = {};
    const nets = new Set<string>();
    for (const pad of await board.getPads()) {
      if (!pad.parent || !ids.has(pad.parent)) continue;
      const ref = footprints.find((fp) => fp.id === pad.parent)?.reference ?? pad.parent;
      pads[ref] = (pads[ref] ?? 0) + 1;
      if (pad.net) nets.add(pad.net);
    }
    const excluded: ComponentScope["excluded"] = [];
    const planeNets = new Set((opts.excludePlaneNets ?? true) ? (await board.getZones()).map((z) => z.net ?? "").filter(Boolean) : []);
    const drop = new Set(opts.excludeNets ?? []);
    const kept: string[] = [];
    for (const net of [...nets].sort()) {
      if (planeNets.has(net)) excluded.push({ net, reason: "owns a copper pour" });
      else if (drop.has(net)) excluded.push({ net, reason: "excluded by request" });
      else kept.push(net);
    }
    return { components, missing, nets: kept, excluded, pads };
  };

  const searchFootprints = async (query: string, limit: number): Promise<FootprintHit[]> => {
    const kicad = await anyKicad();
    const tokens = query.toLowerCase().split(/[\s:]+/).filter(Boolean);
    const nicknames = await kicad.libraries.nicknames("footprint");
    const scored = nicknames.map((n) => ({ n, hit: tokens.filter((t) => n.toLowerCase().includes(t)).length })).sort((a, b) => b.hit - a.hit);
    const hits: FootprintHit[] = [];
    const filter = tokens.join(" ");
    for (const { n, hit } of scored) {
      if (hits.length >= limit) break;
      // Libraries whose name matches take everything matching the rest; others only exact-ish entry hits.
      const entries = await kicad.libraries.entries("footprint", n, hit ? tokens.filter((t) => !n.toLowerCase().includes(t)).join(" ") : filter).catch(() => []);
      for (const e of entries) {
        if (hits.length >= limit) break;
        hits.push({ libId: `${n}:${e.name}`, nickname: n, name: e.name, description: e.description ?? "" });
      }
    }
    return hits;
  };

  /** Any live KiCad for server-wide questions (libraries); a bare session when no project is open. */
  const anyKicad = async (): Promise<KiCad> => (await deps.sessions.session("")).kicad;

  const status = async (): Promise<DesignStatus> => {
    const bridge = deps.bridge();
    try {
      const h = await bridge.health();
      return { url: bridge.url, ok: h.ok, ...(h.kicadCliExists !== undefined ? { kicadCliExists: h.kicadCliExists } : {}), ...(h.compile?.frontends ? { frontends: h.compile.frontends } : {}) };
    } catch (e) {
      return { url: bridge.url, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };

  return { build, query, route, cancelRoute, unroute, scope, searchFootprints, status, release: (dir) => deps.sessions.release(dir) };
}

/** Exposed for tests. */
export type { Board };
