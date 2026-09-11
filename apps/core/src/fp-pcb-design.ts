/**
 * `DesignService` on a FabPlane PCB bridge: the netlist is compiled by the bridge's compile job,
 * routing by its route job, and everything else (queries, unroute, scope, library search) goes
 * through the typed client on the project's session. Positions come back in millimetres; the
 * client speaks nanometres.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ElectricalPinType, KiCadObjectType } from "@fp-pcb/proto";
import {
  LibFootprint,
  LibSymbol,
  SchematicPin,
  Via,
  toMm,
  type Board,
  type KiCad,
} from "@fp-pcb/client";
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
  type PartDescription,
  type PartCompatibility,
  type RouteJobOptions,
  type RouteProgress,
  type RouteSummary,
} from "@fabdesk/tools";
import type { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { BOARD_PCB, BOARD_PRO, type FpPcbSessions } from "./fp-pcb-session";
import type { KicadLibraryCatalog } from "./kicad-library-catalog";

/** The `@fp-pcb/compile` frontend that reads `circuit.netlist.json` (its `NETLIST_JSON_KIND`). */
export const NETLIST_JSON_KIND = "netlist-json";

const STAGE_FRACTION: Record<string, number> = {
  queued: 0.05,
  frontend: 0.1,
  validating: 0.15,
  checking: 0.25,
  cleaning: 0.3,
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
  catalog?: KicadLibraryCatalog;
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
    opts.progress?.(0.05, "session");
    let sessionWasBare = false;
    const job = await deps.sessions.withRetry(opts.projectDir, (s) => {
      sessionWasBare = !s.path;
      return deps.bridge().compile(
        s.id,
        {
          source,
          ...(s.path ? {} : { project: { path: join(opts.projectDir, BOARD_PRO) } }),
          ...(opts.board ? { board: opts.board } : {}),
          ...(opts.rebuild ? { rebuild: opts.rebuild } : {}),
          autoplace: true,
          save: true,
          netlistPath: PROJECT_FILES.compileNet,
        },
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (j: FpPcbCompileJob) =>
            opts.progress?.(STAGE_FRACTION[j.state] ?? 0.5, j.state),
        },
      );
    });
    // The project may have been created by this job: the session now has a board and a path.
    if (job.state === "cancelled") throw new ToolError("compile cancelled", "cancelled");
    const durationMs = Math.round(performance.now() - started);
    const empty = { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 };
    if (!job.result) {
      // NewProject can write its stub files before a later backend-load failure. The session is
      // still recorded as bare in that case; release it so the next build reconnects through the
      // generated board instead of calling NewProject again and getting "already exists" forever.
      if (
        sessionWasBare &&
        /^NewProject:/i.test(job.error ?? "") &&
        (await exists(join(opts.projectDir, BOARD_PCB)))
      ) {
        await deps.sessions.release(opts.projectDir);
      }
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
    }
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
      ...(job.removedCopper ? { removedCopper: job.removedCopper } : {}),
      ...(job.rejectedSchematicPath ? { rejectedSchematicPath: job.rejectedSchematicPath } : {}),
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
          .map((n) => ({
            name: n.name,
            code: n.code?.value ?? 0,
            pads: counts.get(n.name) ?? 0,
          }))
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
            id: pad.id,
            layer: pad.layerId,
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
      geometry: s.geometry.map((shape) => ({
        kind: shape.kind,
        id: shape.id,
        layer: shape.layer,
        net: shape.net,
        points: shape.points.map(mm),
        ...(shape.width !== undefined ? { width: mm(shape.width) } : {}),
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

  const unroute = async (
    projectDir: string,
    nets?: string[],
  ): Promise<{ tracks: number; vias: number }> => {
    const board = await deps.sessions.board(projectDir);
    const wanted = nets?.length ? new Set(nets) : null;
    // A free prefab via has no net and is part of the blank, not routed copper. Preserve it when
    // unrouting the whole board; an explicitly named-net unroute cannot select it anyway.
    const items = (await board.getTracks()).filter(
      (t) => (!(t instanceof Via) || Boolean(t.net)) && (!wanted || wanted.has(t.net ?? "")),
    );
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

  const searchLibraries = async (
    kind: "footprint" | "symbol",
    query: string,
    limit: number,
  ): Promise<FootprintHit[]> => {
    if (deps.catalog?.has(kind)) return deps.catalog.search(kind, query, limit);
    const kicad = await anyKicad();
    const tokens = query
      .toLowerCase()
      .split(/[\s:]+/)
      .filter(Boolean);
    const nicknames = await kicad.libraries.nicknames(kind);
    const scored = nicknames
      .map((n) => ({ n, hit: tokens.filter((t) => n.toLowerCase().includes(t)).length }))
      .sort((a, b) => b.hit - a.hit);
    const hits: FootprintHit[] = [];
    const filter = tokens.join(" ");
    for (const { n, hit } of scored) {
      if (hits.length >= limit) break;
      // Libraries whose name matches take everything matching the rest; others only exact-ish entry hits.
      const entries = await kicad.libraries
        .entries(
          kind,
          n,
          hit ? tokens.filter((t) => !n.toLowerCase().includes(t)).join(" ") : filter,
        )
        .catch(() => []);
      for (const e of entries) {
        if (hits.length >= limit) break;
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
  const searchFootprints = (query: string, limit: number) =>
    searchLibraries("footprint", query, limit);
  const searchSymbols = (query: string, limit: number) => searchLibraries("symbol", query, limit);
  const describePart = async (
    kind: "footprint" | "symbol",
    libId: string,
  ): Promise<PartDescription> => {
    if (deps.catalog?.has(kind)) {
      const item = await deps.catalog.describe(kind, libId);
      if (item) return item;
      throw new ToolError(
        `${kind} ${libId} was not found in the bundled KiCad libraries`,
        "not_found",
      );
    }
    const kicad = await anyKicad();
    const item = await kicad.libraries.get(kind, libId);
    if (!item)
      throw new ToolError(
        `${kind} ${libId} was not found in the design server libraries`,
        "not_found",
      );
    if (kind === "symbol" && item instanceof LibSymbol) {
      const pins = item.items.filter(
        (child): child is SchematicPin => child instanceof SchematicPin,
      );
      return {
        kind,
        libId,
        description: item.description,
        pins: pins.map((pin) => ({
          number: pin.number,
          name: pin.name,
          electricalType: ElectricalPinType[pin.electricalType] ?? String(pin.electricalType),
          position: { x: mm(pin.position.x), y: mm(pin.position.y) },
        })),
        fabrication: {
          courtyard: "unsupported",
          fabOutline: "unsupported",
          threeDModels: "unsupported",
          models: [],
          includedInBom: "unsupported",
          includedInPositionFiles: "unsupported",
        },
      };
    }
    if (kind === "footprint" && item instanceof LibFootprint) {
      return {
        kind,
        libId,
        description: item.description,
        anchor: { x: mm(item.anchor.x), y: mm(item.anchor.y) },
        pads: item.pads.map((pad) => ({
          number: pad.number,
          position: {
            x: mm(pad.position.x - item.anchor.x),
            y: mm(pad.position.y - item.anchor.y),
          },
          size: { x: mm(pad.size.x), y: mm(pad.size.y) },
        })),
        package: { assemblyMethod: "unspecified" },
        fabrication: {
          courtyard: "unsupported",
          fabOutline: "unsupported",
          threeDModels: "unsupported",
          models: [],
          includedInBom: "unsupported",
          includedInPositionFiles: "unsupported",
        },
      };
    }
    throw new ToolError(`${libId} did not resolve as a ${kind}`, "invalid_args");
  };
  const checkPartCompatibility = async (
    symbolLibId: string,
    footprintLibId: string,
    role?: "power-only-usb-c",
  ): Promise<PartCompatibility> => {
    const [symbol, footprint] = await Promise.all([
      describePart("symbol", symbolLibId),
      describePart("footprint", footprintLibId),
    ]);
    return evaluatePartCompatibility(symbol, footprint, role);
  };

  /** Any live KiCad for server-wide questions (libraries); a bare session when no project is open. */
  const anyKicad = async (): Promise<KiCad> => (await deps.sessions.session("")).kicad;

  const status = async (): Promise<DesignStatus> => {
    const bridge = deps.bridge();
    try {
      const h = await bridge.health();
      return {
        url: bridge.url,
        ok: h.ok,
        ...(h.kicadCliExists !== undefined ? { kicadCliExists: h.kicadCliExists } : {}),
        ...(h.compile?.frontends ? { frontends: h.compile.frontends } : {}),
        routers: {
          ...(h.jsAutorouter ? { capacity: { ok: h.jsAutorouter.ok, ...(h.jsAutorouter.reason ? { reason: h.jsAutorouter.reason } : {}) } } : {}),
          ...(h.freerouting ? { freerouting: { ok: h.freerouting.ok, ...(h.freerouting.reason ? { reason: h.freerouting.reason } : {}) } } : {}),
        },
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
    searchSymbols,
    describePart,
    checkPartCompatibility,
    status,
    release: (dir) => deps.sessions.release(dir),
  };
}

/** Pure compatibility contract used before any placement or project mutation. */
export function evaluatePartCompatibility(
  symbol: PartDescription,
  footprint: PartDescription,
  role?: "power-only-usb-c",
): PartCompatibility {
  const pins = new Set(
    (symbol.pins ?? [])
      .filter((pin) => pin.electricalType !== "PT_NC")
      .map((pin) => pin.number)
      .filter(Boolean),
  );
  const pads = new Set((footprint.pads ?? []).map((pad) => pad.number).filter(Boolean));
  const matched = [...pins].filter((number) => pads.has(number)).sort();
  const missingPadsForPins = [...pins].filter((number) => !pads.has(number)).sort();
  const padsWithoutPins = [...pads].filter((number) => !pins.has(number)).sort();
  const electricalExtras = padsWithoutPins.filter(
    (number) => !/^(sh|shield|mp|mh|mount|ep)$/i.test(number),
  );
  const issues = missingPadsForPins.map((number) => `symbol pin ${number} has no footprint pad`);
  const warnings = [
    ...electricalExtras.map((number) => `footprint pad ${number} has no symbol pin`),
    ...padsWithoutPins
      .filter((number) => !electricalExtras.includes(number))
      .map((number) => `mechanical/shield pad ${number} has no symbol pin`),
  ];
  let roleResult: PartCompatibility["role"];
  if (role) {
    const symbolRole = symbol.roleSuitability?.find((entry) => entry.role === role);
    const footprintRole = footprint.roleSuitability?.find((entry) => entry.role === role);
    const suitable = Boolean(symbolRole?.suitable && footprintRole?.suitable);
    roleResult = {
      role,
      suitable,
      reasons: [
        ...(symbolRole?.reasons ?? ["symbol role metadata unavailable"]),
        ...(footprintRole?.reasons ?? ["footprint role metadata unavailable"]),
      ],
    };
    if (!suitable) issues.push(`${role} suitability could not be established for both parts`);
  }
  return {
    symbolLibId: symbol.libId,
    footprintLibId: footprint.libId,
    symbol,
    footprint,
    compatible: issues.length === 0,
    pinPad: {
      compatible: missingPadsForPins.length === 0,
      matched,
      missingPadsForPins,
      padsWithoutPins,
    },
    ...(roleResult ? { role: roleResult } : {}),
    issues,
    warnings,
  };
}

/** Exposed for tests. */
export type { Board };
