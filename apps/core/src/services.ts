/** Real CoreServices: wires the sibling packages into the interface `@fabdesk/tools` expects. */
import * as tsc from "@fabdesk/tscircuit";
import * as kicad from "@fabdesk/kicad";
import { RouterHost, availableRouters } from "@fabdesk/router";
import { captureCoreException } from "./sentry";
import * as sim from "@fabdesk/sim";
import type { Principal, RouteRequest, RouteResult, RouterWorkerMessage, Settings } from "@fabdesk/protocol";
import type { CoreServices, KicadCli, RouteRunStore, SimService } from "@fabdesk/tools";
import type { Channel } from "./config";
import type { EventBus } from "./bus";
import type { ProjectStore } from "./projects";
import { routerHostOptions } from "./router-worker-url";

export type ServiceDeps = {
  version: string;
  channel: Channel;
  settings: () => Settings;
  projects: ProjectStore;
  bus: EventBus;
  routeRuns: RouteRunStore;
  principal: () => Principal | null;
  /** Directory for router-worker scratch files etc. */
  home: string;
};

function simService(settings: () => Settings): SimService {
  const toSimAnalysis = (a: Parameters<SimService["runSimulation"]>[0]["analysis"]): sim.SimAnalysis => {
    switch (a.type) {
      case "op":
        return { kind: "op" };
      case "tran":
        return { kind: "tran", stopS: a.stopS, stepS: a.stepS ?? a.stopS / 1000 };
      case "ac":
        return { kind: "ac", startHz: a.startHz, stopHz: a.stopHz, pointsPerDecade: a.points ?? 10 };
    }
  };
  return {
    spiceNetlist: (cj) => sim.spiceNetlist(cj),
    runSimulation: async (o) => {
      const t0 = Date.now();
      const r = await sim.runSimulation({
        circuitJson: o.circuitJson,
        analysis: toSimAnalysis(o.analysis),
        ...(o.engine ? { engine: o.engine } : {}),
        ...(o.ngspicePath ? { ngspicePath: o.ngspicePath } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return { engine: r.engine, analysis: r.analysis, columns: r.columns, rows: r.rows, ...(r.log ? { notes: [r.log] } : {}), durationMs: Date.now() - t0 };
    },
    findNgspice: (explicit) => sim.findNgspice(explicit ?? settings().ngspicePath ?? undefined),
  };
}

export async function createServices(deps: ServiceDeps): Promise<CoreServices & { dispose(): void }> {
  const host = new RouterHost(routerHostOptions());
  let activeRoute: { runId: string } | null = null;

  const resolveCli = async (): Promise<KicadCli | null> => {
    const explicit = deps.settings().kicadCliPath ?? undefined;
    const found = await kicad.findKicadCli(explicit);
    return found ? { path: found.path, version: found.version } : null;
  };

  const services: CoreServices & { dispose(): void } = {
    version: deps.version,
    channel: deps.channel,
    settings: deps.settings,
    projects: deps.projects,
    bus: deps.bus,
    routeRuns: deps.routeRuns,
    principal: deps.principal,
    tscircuit: {
      buildCircuit: async (o) => {
        const r = await tsc.buildCircuit(o);
        return { ...r, warnings: r.warnings.map((w) => ({ message: w })) };
      },
      runChecks: (cj) => tsc.runChecks(cj),
      queryCircuit: (cj, select, filter) => tsc.queryCircuit(cj, select, filter) as unknown[],
      extractSimpleRouteJson: (cj, o) => tsc.extractSimpleRouteJson(cj, o ?? {}),
      mergeTraces: (cj, traces, map) => tsc.mergeTraces(cj, traces, map),
      unrouteCircuit: (cj, conns) => tsc.unrouteCircuit(cj, conns),
      schematicSvg: (cj) => tsc.schematicSvg(cj),
      pcbSvg: (cj) => tsc.pcbSvg(cj),
    },
    kicad: {
      resolveCli,
      convertToKicad: (o) => kicad.convertToKicad(o),
      runDrc: (cli, o) => kicad.runDrc(cli, o),
      runErc: (cli, o) => kicad.runErc(cli, o),
      gate: (drc, erc, allowed) => kicad.gate(drc as kicad.DrcReport, erc as kicad.ErcReport | undefined, allowed),
      renderPng: (cli, o) => kicad.renderPng(cli, o),
      exportGlb: (cli, o) => kicad.exportGlb(cli, o),
      boardStats: async (cli, o) => (await kicad.boardStats(cli, o.board, o.scratchFile)) as unknown as Record<string, unknown>,
      exportGerbers: (cli, o) => kicad.exportGerbers(cli, o),
      exportDrill: (cli, o) => kicad.exportDrill(cli, o),
      exportPos: (cli, o) => kicad.exportPos(cli, o),
      exportBom: (cli, o) => kicad.exportBom(cli, o),
      exportNetlist: (cli, o) => kicad.exportNetlist(cli, o),
      exportSchematicSvg: (cli, o) => kicad.exportSchematicSvg(cli, o),
    },
    router: {
      route: async (request: RouteRequest, { onMessage, signal }: { onMessage(m: RouterWorkerMessage): void; signal?: AbortSignal }): Promise<RouteResult> => {
        activeRoute = { runId: request.runId };
        const report = (m: RouterWorkerMessage) => {
          if (m.kind === "error") captureCoreException(new Error(m.message), { component: "router-worker", router: request.router });
          onMessage(m);
        };
        try {
          return await host.route(request, { onMessage: report, signal });
        } finally {
          activeRoute = null;
        }
      },
      cancel: (runId) => {
        if (!runId || activeRoute?.runId === runId) host.cancel();
      },
      available: () => availableRouters(),
    },
    sim: simService(deps.settings),
    dispose: () => host.dispose(),
  };
  return services;
}
