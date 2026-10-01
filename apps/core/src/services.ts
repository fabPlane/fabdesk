/** Real CoreServices: wires the sibling packages and the FabPlane PCB and CAD bridges into the interface `@fabdesk/tools` expects. */
import * as kicad from "@fabdesk/kicad";
import * as sim from "@fabdesk/sim";
import type { Principal, Settings } from "@fabdesk/protocol";
import { ToolError, type CoreServices, type KicadCli, type RouteRunStore, type SimService } from "@fabdesk/tools";
import type { Channel } from "./config";
import { fabCadBridgeUrl, fpPcbBridgeUrl } from "./config";
import type { EventBus } from "./bus";
import type { ProjectStore } from "./projects";
import { AppBridgeClient } from "./app-bridge";
import { createFabCad } from "./fab-cad";
import { FabCadBridgeClient } from "./fab-cad-bridge";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbSessions } from "./fp-pcb-session";
import { logger } from "./log";
import { KicadLibraryCatalog } from "./kicad-library-catalog";
import type { RunTelemetry } from "./run-telemetry";
import { RouteTaskQueue } from "./route-tasks";

export type ServiceDeps = {
  version: string;
  runtimeId?: string | null;
  channel: Channel;
  settings: () => Settings;
  projects: ProjectStore;
  bus: EventBus;
  routeRuns: RouteRunStore;
  principal: () => Principal | null;
  /** Directory for scratch files etc. */
  home: string;
  /** Daemon token; with `appBridgeFile` enables the desktop app automation bridge (`app` toolset). */
  token?: string;
  /** Path of app-bridge.json written by the desktop app (see app-bridge.ts). */
  appBridgeFile?: string;
  telemetry?: Pick<RunTelemetry, "traceKicadCli">;
};

function simService(settings: () => Settings): SimService {
  const toSimAnalysis = (
    a: Parameters<SimService["runSpiceSimulation"]>[0]["analysis"],
  ): sim.SimAnalysis => {
    switch (a.type) {
      case "op":
        return { kind: "op" };
      case "tran":
        return { kind: "tran", stopS: a.stopS, stepS: a.stepS ?? a.stopS / 1000 };
      case "ac":
        return {
          kind: "ac",
          startHz: a.startHz,
          stopHz: a.stopHz,
          pointsPerDecade: a.points ?? 10,
        };
    }
  };
  return {
    runSpiceSimulation: async (o) => {
      const t0 = Date.now();
      const analysis = toSimAnalysis(o.analysis);
      const engine = o.engine ?? "spicey";
      const r =
        engine === "ngspice"
          ? await sim.runNgspice(o.ngspicePath ?? "ngspice", o.netlist, analysis, o.signal)
          : sim.runSpicey(o.netlist, analysis);
      return {
        engine: r.engine,
        analysis: r.analysis,
        columns: r.columns,
        rows: r.rows,
        ...(r.log ? { notes: [r.log] } : {}),
        durationMs: Date.now() - t0,
      };
    },
    findNgspice: (explicit) => sim.findNgspice(explicit ?? settings().ngspicePath ?? undefined),
  };
}

export async function createServices(
  deps: ServiceDeps,
): Promise<CoreServices & { dispose(): Promise<void> }> {
  const resolveCli = async (): Promise<KicadCli | null> => {
    const explicit = deps.settings().kicadCliPath ?? undefined;
    const trace = deps.telemetry
      ? (input: kicad.KicadInvocation, invoke: () => Promise<kicad.RunResult>) =>
          deps.telemetry!.traceKicadCli(input, invoke)
      : undefined;
    return kicad.findKicadCli(explicit, { ...(trace ? { trace } : {}) });
  };

  // One bridge client per configured URL; re-created when the setting changes.
  let bridge: { url: string; client: FpPcbBridgeClient } | null = null;
  const bridgeClient = (): FpPcbBridgeClient => {
    const url = fpPcbBridgeUrl(deps.settings().fpPcbBridgeUrl);
    if (!bridge || bridge.url !== url) bridge = { url, client: new FpPcbBridgeClient({ url }) };
    return bridge.client;
  };
  const sessions = new FpPcbSessions(bridgeClient, {
    clientName: `fabdesk/core/${process.pid}`,
    log: (m) => logger.info(m),
  });
  const routeTasks = new RouteTaskQueue();
  let cadBridge: FabCadBridgeClient | null = null;
  const cadBridgeClient = (): FabCadBridgeClient => {
    const url = fabCadBridgeUrl();
    if (!cadBridge || cadBridge.url !== url) cadBridge = new FabCadBridgeClient({ url });
    return cadBridge;
  };
  const cad = createFabCad({
    bridge: cadBridgeClient,
    clientName: `fabdesk/core/${process.pid}`,
    log: (m) => logger.info(m),
  });

  const services: CoreServices & { dispose(): Promise<void> } = {
    version: deps.version,
    runtimeId: deps.runtimeId ?? null,
    channel: deps.channel,
    settings: deps.settings,
    projects: deps.projects,
    bus: deps.bus,
    routeRuns: deps.routeRuns,
    routeTasks,
    principal: deps.principal,
    design: createFpPcbDesign({
      bridge: bridgeClient,
      sessions,
      catalog: new KicadLibraryCatalog({
        footprints: process.env["KICAD_FOOTPRINT_DIR"],
        symbols: process.env["KICAD_SYMBOL_DIR"],
      }),
    }),
    kicad: {
      resolveCli,
      runDrc: (cli, o) => kicad.runDrc(cli, o),
      runErc: (cli, o) => kicad.runErc(cli, o),
      inspectSchematicHierarchy: (cli, o) => kicad.inspectSchematicHierarchy(cli, o),
      gate: (drc, erc, allowed) =>
        kicad.gate(drc as kicad.DrcReport, erc as kicad.ErcReport | undefined, allowed),
      renderPng: (cli, o) => kicad.renderPng(cli, o),
      rasterizeSvg: (svg, o) => kicad.rasterizeSvg(svg, o),
      exportGlb: (cli, o) => kicad.exportGlb(cli, o),
      measureMechanical: (cli, o) => kicad.collectMechanical(cli, o),
      boardStats: async (cli, o) => {
        try {
          return (await kicad.boardStats(cli, o.board, o.scratchFile)) as unknown as Record<string, unknown>;
        } catch (error) {
          if (error instanceof kicad.BoardStatsUnavailableError)
            throw new ToolError(error.message, "unavailable");
          throw error;
        }
      },
      exportGerbers: (cli, o) => kicad.exportGerbers(cli, o),
      exportDrill: (cli, o) => kicad.exportDrill(cli, o),
      exportDxf: (cli, o) => kicad.exportDxf(cli, o),
      exportPos: (cli, o) => kicad.exportPos(cli, o),
      exportBom: (cli, o) => kicad.exportBom(cli, o),
      exportNetlist: (cli, o) => kicad.exportNetlist(cli, o),
      exportSchematicSvg: (cli, o) => kicad.exportSchematicSvg(cli, o),
      exportSchematicPdf: (cli, o) => kicad.exportSchematicPdf(cli, o),
      exportPcbSvg: (cli, o) => kicad.exportPcbSvg(cli, o),
    },
    sim: simService(deps.settings),
    ...(deps.token && deps.appBridgeFile
      ? { appBridge: new AppBridgeClient({ file: deps.appBridgeFile, token: deps.token }) }
      : {}),
    cad,
    dispose: async () => {
      await Promise.all([sessions.dispose(), cad.dispose()]);
    },
  };
  return services;
}
