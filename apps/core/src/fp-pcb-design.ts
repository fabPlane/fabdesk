/**
 * `DesignService` on a FabPlane PCB bridge: the netlist is compiled by the bridge's compile job,
 * routing by its route job, and everything else (queries, unroute, scope, library search) goes
 * through the typed client on the project's session. Positions come back in millimetres; the
 * client speaks nanometres.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardLayer, KiCadObjectType } from "@fp-pcb/proto";
import { Via, toMm, type Board, type KiCad } from "@fp-pcb/client";
import { placeFootprints } from "@fabdesk/kicad";
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

const STAGE_FRACTION: Record<string, number> = {
  queued: 0.05,
  frontend: 0.1,
  validating: 0.15,
  checking: 0.25,
  outlining: 0.35,
  importing: 0.5,
  placing: 0.7,
  saving: 0.85,
};
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
    ...(p?.percent !== undefined ? { percent: p.percent } : {}),
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
      return {
        ok: false,
        errors: [
          {
            type: "missing_entrypoint",
            message: `${entrypoint} not found in ${opts.projectDir}`,
            file: entrypoint,
          },
        ],
        warnings: [],
        counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 },
        durationMs: 0,
      };
    }
    const source = {
      kind: NETLIST_JSON_KIND,
      files: { [entrypoint]: await readText(entryPath) },
      entrypoint,
    };
    if (opts.fresh) {
      // The session keeps the board in memory and the compile only draws an outline when none
      // exists, so a size change (or a placement the user wants redone) needs the slate wiped:
      // drop the session, then the generated files, and let the compile create the project anew.
      await deps.sessions.release(opts.projectDir);
      for (const f of ["board.kicad_pcb", "board.kicad_pro", "board.kicad_prl", "board.kicad_sch"])
        await rm(join(opts.projectDir, f), { force: true });
    }
    opts.progress?.(0.05, "session");
    const job = await deps.sessions.withRetry(opts.projectDir, (s) =>
      deps.bridge().compile(
        s.id,
        {
          source,
          ...(s.path ? {} : { project: { path: join(opts.projectDir, BOARD_PRO) } }),
          ...(opts.board ? { board: opts.board } : {}),
          autoplace: true,
          save: true,
          netlistPath: PROJECT_FILES.compileNet,
        },
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (j: FpPcbCompileJob) =>
            opts.progress?.(STAGE_FRACTION[j.state] ?? 0.5, j.state),
        },
      ),
    );
    // The project may have been created by this job: the session now has a board and a path.
    if (job.state === "cancelled") throw new ToolError("compile cancelled", "cancelled");
    const durationMs = Math.round(performance.now() - started);
    const empty = { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 };
    if (!job.result)
      return {
        ok: false,
        errors: [
          {
            type: "compile_job_failed",
            message:
              job.error ?? `compile job ${job.id} ended in state ${job.state} with no result`,
          },
        ],
        warnings: [],
        counts: empty,
        durationMs,
      };
    const errors = job.result.diagnostics.filter((d) => d.severity === "error").map(toBuildError);
    const warnings = job.result.diagnostics
      .filter((d) => d.severity === "warning")
      .map(toBuildError);
    return {
      ok: job.result.ok && errors.length === 0,
      errors,
      warnings,
      counts: job.result.counts,
      durationMs,
      ...(job.revision !== undefined ? { revision: job.revision } : {}),
    };
  };

  const query = async (
    projectDir: string,
    select: DesignSelect,
    filter?: string,
  ): Promise<DesignRow[]> => {
    const board = await deps.sessions.board(projectDir);
    const f = filter?.toLowerCase();
    const keep = (...fields: unknown[]) =>
      !f ||
      fields.some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(f),
      );
    switch (select) {
      case "outline": {
        // Edge.Cuts bounding box, so placements can be reasoned about in the board's own coordinates
        // (the compile does not put the outline's corner at 0,0).
        const pt = (v: { xNm?: bigint | number; yNm?: bigint | number } | undefined) => ({
          x: Number(v?.xNm ?? 0),
          y: Number(v?.yNm ?? 0),
        });
        const pts: Array<{ x: number; y: number }> = [];
        for (const s of await board.getShapes()) {
          if (s.layerId !== BoardLayer.BL_Edge_Cuts) continue;
          const g = s.shape?.geometry;
          if (g?.case === "segment") pts.push(pt(g.value.start), pt(g.value.end));
          else if (g?.case === "arc") pts.push(pt(g.value.start), pt(g.value.mid), pt(g.value.end));
          else if (g?.case === "rectangle") pts.push(pt(g.value.topLeft), pt(g.value.bottomRight));
          else if (g?.case === "circle") {
            const c = pt(g.value.center);
            const r = pt(g.value.radiusPoint);
            const rad = Math.hypot(r.x - c.x, r.y - c.y);
            pts.push({ x: c.x - rad, y: c.y - rad }, { x: c.x + rad, y: c.y + rad });
          }
        }
        if (!pts.length) return [];
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        return [
          { minX: mm(minX), minY: mm(minY), maxX: mm(maxX), maxY: mm(maxY), widthMm: mm(maxX - minX), heightMm: mm(maxY - minY) },
        ];
      }
      case "components": {
        return (await board.getFootprints())
          .map((fp) => ({
            ref: fp.reference,
            value: fp.value,
            footprint: fp.libraryId,
            x: mm(fp.position.x),
            y: mm(fp.position.y),
            layer: fp.layerId,
          }))
          .filter((r) => keep(r.ref, r.value, r.footprint));
      }
      case "nets": {
        const pads = await board.getPads();
        const counts = new Map<string, number>();
        for (const pad of pads) {
          const net = pad.net ?? "";
          if (net) counts.set(net, (counts.get(net) ?? 0) + 1);
        }
        return (await board.nets())
          .map((n) => ({ name: n.name, code: n.code, pads: counts.get(n.name) ?? 0 }))
          .filter((r) => keep(r.name));
      }
      case "pads": {
        const refs = new Map((await board.getFootprints()).map((fp) => [fp.id, fp.reference]));
        return (await board.getPads())
          .map((pad) => ({
            component: refs.get(pad.parent ?? "") ?? pad.parent ?? "",
            number: pad.number,
            net: pad.net ?? "",
            x: mm(pad.position.x),
            y: mm(pad.position.y),
            width: mm(pad.size.x),
            height: mm(pad.size.y),
          }))
          .filter((r) => keep(r.component, r.net, r.number));
      }
      case "vias": {
        return (await board.getTracks())
          .filter((t): t is Via => t instanceof Via)
          .map((v) => ({
            id: v.id,
            net: v.net ?? "",
            x: mm(v.position.x),
            y: mm(v.position.y),
            diameter: mm(v.diameter),
            drill: mm(v.drillDiameter),
          }))
          .filter((r) => keep(r.net, r.id));
      }
      case "tracks": {
        return (await board.getTracks())
          .map((t) => ({
            kind: t.typeName.replace(/^.*\./, ""),
            net: t.net ?? "",
            layer: t.layerId ?? "",
            id: t.id,
          }))
          .filter((r) => keep(r.net));
      }
      case "unrouted": {
        return (await board.ratsnest()).edges
          .map((e) => ({
            net: e.net,
            from: `${mm(e.sourcePosition.x)},${mm(e.sourcePosition.y)}`,
            to: `${mm(e.targetPosition.x)},${mm(e.targetPosition.y)}`,
          }))
          .filter((r) => keep(r.net));
      }
    }
  };

  const route = async (
    projectDir: string,
    opts: RouteJobOptions,
    hooks: { onProgress?: (p: RouteProgress) => void; signal?: AbortSignal },
  ): Promise<RouteSummary> => {
    await deps.sessions.board(projectDir); // fails early with a precondition when nothing is built
    const job = await deps.sessions.withRetry(projectDir, async (s) => {
      active.set(projectDir, s.id);
      try {
        return await deps.bridge().route(
          s.id,
          {
            router: opts.router === "freerouting" ? "freerouting" : "js",
            options: {
              ...(opts.nets ? { nets: opts.nets } : {}),
              ...(opts.maxTimeMs ? { maxTimeMs: opts.maxTimeMs } : {}),
              ...(opts.settings ?? {}),
            },
            ...(opts.refillZones !== undefined ? { refillZones: opts.refillZones } : {}),
          },
          {
            ...(hooks.signal ? { signal: hooks.signal } : {}),
            maxMs: (opts.maxTimeMs ?? 120_000) + 5 * 60_000,
            onProgress: (j) => hooks.onProgress?.(toRouteProgress(j)),
          },
        );
      } finally {
        active.delete(projectDir);
      }
    });
    if (job.state === "cancelled") throw new ToolError("route cancelled", "cancelled");
    if (job.state === "failed" || !job.summary)
      throw new ToolError(
        job.error ?? `route job ${job.id} ended in state ${job.state}`,
        "internal",
      );
    // The route job saves before routing (for the DSN export), not after applying: every tool
    // downstream reads the file, so persist what the job put on the board.
    await saveBoard(projectDir);
    const s = job.summary;
    return {
      tracks: s.tracks,
      vias: s.vias,
      claimedVias: s.claimedVias,
      ...(s.preset ? { preset: s.preset } : {}),
      routed: s.routed,
      total: s.total,
      trackLengthNm: s.trackLengthNm,
      elapsedMs: s.elapsedMs,
      wallMs: s.wallMs,
      timedOut: s.timedOut,
      message: s.message,
      unrouted: s.unrouted.map((u) => ({
        net: u.net,
        from: { x: mm(u.from.x), y: mm(u.from.y) },
        to: { x: mm(u.to.x), y: mm(u.to.y) },
      })),
      log: s.log,
    };
  };

  /** `SaveDocument` on the project's board, so kicad-cli tools and the app see what the session holds. */
  const saveBoard = async (projectDir: string): Promise<void> => {
    const board = await deps.sessions.board(projectDir);
    await board.save();
  };

  const cancelRoute = async (projectDir?: string): Promise<void> => {
    const ids = projectDir
      ? [active.get(projectDir)].filter((v): v is string => !!v)
      : [...active.values()];
    for (const id of ids)
      await deps
        .bridge()
        .cancelJobs("route", id)
        .catch(() => 0);
  };

  /**
   * Move footprints by rewriting their transform in the saved file, then reload the board into the
   * session: the API's UpdateItems moves only a footprint's anchor (fab_pcb gap G28), the file
   * format keeps children relative, so this is the one way to place parts today.
   */
  const place = async (
    projectDir: string,
    placements: Array<{ ref: string; x: number; y: number; rotation?: number }>,
  ): Promise<{ moved: Array<{ ref: string; x: number; y: number; rotation: number }>; missing: string[] }> => {
    const board = await deps.sessions.board(projectDir);
    await board.save();
    const pcb = join(projectDir, "board.kicad_pcb");
    const result = placeFootprints(await readText(pcb), placements);
    if (result.moved.length) {
      await writeFile(pcb, result.text);
      await deps.sessions.withRetry(projectDir, async (s) => {
        await board.close().catch(() => undefined);
        await s.kicad.openBoard(pcb);
      });
    }
    return { moved: result.moved, missing: result.missing };
  };

  const unroute = async (
    projectDir: string,
    nets?: string[],
  ): Promise<{ tracks: number; vias: number }> => {
    const board = await deps.sessions.board(projectDir);
    const wanted = nets?.length ? new Set(nets) : null;
    const items = (await board.getTracks()).filter((t) => !wanted || wanted.has(t.net ?? ""));
    const vias = items.filter((t) => t.typeName.endsWith("Via")).length;
    if (items.length) {
      await board.commit(wanted ? `Unroute ${[...wanted].join(", ")}` : "Unroute all", (tx) =>
        tx.delete(items),
      );
      await saveBoard(projectDir);
    }
    return { tracks: items.length - vias, vias };
  };

  const scope = async (
    projectDir: string,
    refs: string[],
    opts: { excludePlaneNets?: boolean; excludeNets?: string[] } = {},
  ): Promise<ComponentScope> => {
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
    const planeNets = new Set(
      (opts.excludePlaneNets ?? true)
        ? (await board.getZones()).map((z) => z.net ?? "").filter(Boolean)
        : [],
    );
    const drop = new Set(opts.excludeNets ?? []);
    const kept: string[] = [];
    for (const net of [...nets].sort()) {
      if (planeNets.has(net)) excluded.push({ net, reason: "owns a copper pour" });
      else if (drop.has(net)) excluded.push({ net, reason: "excluded by request" });
      else kept.push(net);
    }
    return { components, missing, nets: kept, excluded, pads };
  };

  const searchFootprints = (query: string, limit: number): Promise<FootprintHit[]> =>
    // Through withRetry: after a bridge restart the cached library session is gone and every search
    // failed with "WebSocket … closed" until the daemon itself restarted.
    deps.sessions.withRetry("", () => searchFootprintsOnce(query, limit));

  const searchFootprintsOnce = async (query: string, limit: number): Promise<FootprintHit[]> => {
    const kicad = await anyKicad();
    const tokens = query
      .toLowerCase()
      .split(/[\s:]+/)
      .filter(Boolean);
    const nicknames = await kicad.libraries.nicknames("footprint");
    const scored = nicknames
      .map((n) => ({ n, hit: tokens.filter((t) => n.toLowerCase().includes(t)).length }))
      .sort((a, b) => b.hit - a.hit);
    const hits: FootprintHit[] = [];
    for (const { n } of scored) {
      if (hits.length >= limit) break;
      // KiCad's entry filter is one substring, so ask with the most specific token the library name
      // does not already cover and match the remaining tokens here against name + description.
      const rest = tokens.filter((t) => !n.toLowerCase().includes(t));
      const [primary, ...others] = [...rest].sort((a, b) => b.length - a.length);
      const entries = await kicad.libraries
        .entries("footprint", n, primary ?? "")
        .catch(() => []);
      for (const e of entries) {
        if (hits.length >= limit) break;
        const hay = `${e.name} ${e.description ?? ""}`.toLowerCase();
        if (!others.every((t) => hay.includes(t))) continue;
        hits.push({
          libId: `${n}:${e.name}`,
          nickname: n,
          name: e.name,
          description: e.description ?? "",
        });
      }
    }
    return hits;
  };

  /**
   * Any live KiCad for server-wide questions (libraries). The api-server only registers the
   * footprint-library handlers once a project is open (`GetLibraryTables` answers `AS_UNHANDLED`
   * on a bare session), so the shared session is given a scratch project the first time.
   */
  const anyKicad = async (): Promise<KiCad> => {
    const { kicad } = await deps.sessions.session("");
    const hasProject = await kicad
      .projectInfo()
      .then(() => true)
      .catch(() => false);
    if (!hasProject) {
      const dir = await mkdtemp(join(tmpdir(), "fabdesk-libs-"));
      await kicad.newProject(join(dir, "libs.kicad_pro"), { skipStubDocuments: true });
    }
    return kicad;
  };

  const status = async (): Promise<DesignStatus> => {
    const bridge = deps.bridge();
    try {
      const h = await bridge.health();
      return {
        url: bridge.url,
        ok: h.ok,
        ...(h.kicadCliExists !== undefined ? { kicadCliExists: h.kicadCliExists } : {}),
        ...(h.compile?.frontends ? { frontends: h.compile.frontends } : {}),
      };
    } catch (e) {
      return { url: bridge.url, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };

  return {
    build,
    query,
    route,
    cancelRoute,
    unroute,
    scope,
    searchFootprints,
    place,
    status,
    release: (dir) => deps.sessions.release(dir),
  };
}

/** Exposed for tests. */
export type { Board };
