/**
 * The layout host of the board tools: where the engines are (KiCadRoutingTools and TraceMaker from Settings → Routers,
 * or their overrides), how a missing one installs on first use (`ensure`, through the router registry), how processes
 * run, the DRC flavours (courtyard gate, refilled scoring) and admission by the resource governor. Shared by
 * `board_route`'s layout stages and its last mile.
 */
import { statfs } from "node:fs/promises";
import { layout, sysinfo } from "@fabdesk/board-workflow";
import { boardMemGiB, governor, routerFootprintFor, sampleHost, type ResourceClass } from "../resources";
import type { ToolContext } from "../registry";
import { requireKicad, runLiveDrc } from "./common";

type LayoutHost = layout.LayoutHost;
const { nodeRun } = layout;

/**
 * Where KiCadRoutingTools lives (a build with `src/plugins` and a `venv`): Settings `krtDir`, then `FABDESK_KRT_DIR`,
 * then the copy Settings → Routers installed. An explicit setting is returned as given, so a wrong path fails the
 * layout `check` by name instead of quietly using another copy.
 */
export const krtDir = (env: NodeJS.ProcessEnv = process.env, settingsDir?: string | null, installed?: string | null): string | null =>
  settingsDir?.trim() || env["FABDESK_KRT_DIR"]?.trim() || installed || null;

/**
 * The engine's path, installing it through the router registry when it is missing and `autoInstallEngines` allows
 * (one install per host even when parallel steps ask at once; concurrent hosts share the registry's install).
 */
export function engineEnsurer(ctx: ToolContext, note: (line: string) => void): NonNullable<LayoutHost["ensure"]> {
  const once = new Map<string, Promise<layout.EngineReady>>();
  return (engine) => {
    let p = once.get(engine);
    if (!p) {
      const routers = ctx.services.routers;
      p = routers
        ? routers.ensure(engine, { onLine: note }).then((r) => (r.path ? { path: r.path } : { path: null, ...(r.why ? { why: r.why } : {}) }))
        : Promise.resolve({ path: null, why: "this host has no router registry to install engines from" });
      once.set(engine, p);
    }
    return p;
  };
}

/** TraceMaker's placer through the router registry (installing or upgrading TraceMaker first); once per host. */
export function placerEnsurer(ctx: ToolContext, note: (line: string) => void): NonNullable<LayoutHost["ensurePlacer"]> {
  let p: Promise<layout.EngineReady> | undefined;
  return () =>
    (p ??= ctx.services.routers
      ? ctx.services.routers.ensurePlacer({ onLine: note }).then((r) => (r.path ? { path: r.path } : { path: null, ...(r.why ? { why: r.why } : {}) }))
      : Promise.resolve({ path: null, why: "this host has no router registry to install engines from" }));
}

export function layoutHost(ctx: ToolContext, kicadCli: string | null, env: NodeJS.ProcessEnv = process.env): LayoutHost {
  const note = (s: string) => ctx.progress(0, s);
  const placer = ctx.services.routers?.get("tracemaker").placer;
  const drc = async (board: string, outFile: string, opts: { parity: boolean; refill: boolean }) => {
    const cli = await requireKicad(ctx);
    return runLiveDrc(ctx, cli, { board, outFile, parity: opts.parity, refill: opts.refill, signal: ctx.signal });
  };
  return {
    tools: {
      krt: krtDir(env, ctx.services.settings?.().krtDir, ctx.services.routers?.executable("krt")),
      tracemaker: ctx.services.routers?.executable("tracemaker") ?? env["TRACEMAKER_BIN"] ?? null,
      tracemakerPlace: env["TRACEMAKER_PLACE_BIN"]?.trim() || (placer?.ready && placer.path ? placer.path : null),
      kicadCli,
    },
    // without a router registry there is nothing to install from: engines are what `tools` names
    ...(ctx.services.routers ? { ensure: engineEnsurer(ctx, note), ensurePlacer: placerEnsurer(ctx, note) } : {}),
    spawn: nodeRun,
    courtyardDrc: async (board, report) => (await drc(board, report, { parity: false, refill: false })).violations.map((v) => ({ rule: v.rule, items: v.items.map((i) => ({ description: i.description })) })),
    scoreDrc: async (board, outFile, parity) => {
      const r = await drc(board, outFile, { parity, refill: true });
      return { violations: r.violations.map((v) => ({ rule: v.rule, severity: v.severity, description: v.description, items: v.items.map((i) => ({ description: i.description })) })), unconnected: r.unconnected.length, parity: r.schematicParity.length };
    },
    admit: async (kind, label, paths, opts) => {
      // KRT and TraceMaker hold a grid over the whole board: estimate from outline area x copper layers, not file size.
      // Freerouting and fab_router (fill steps) are not grid routers; they keep the file-size estimate.
      const gridRouter = (kind === "router" || kind === "tracemaker") && opts?.engine !== "freerouting" && opts?.engine !== "fab_router";
      const fp = gridRouter ? await routerFootprintFor(paths) : null;
      const memGiB = fp ? fp.memGiB : await boardMemGiB(paths);
      // reserve the larger estimate; only the grid term (allocated whatever the plan) may refuse the run
      const job = await governor().admit({ cls: kind as ResourceClass, label, paths, signal: ctx.signal, memGiB, ...(fp ? { hardGiB: fp.gridGiB } : {}), onWait: note });
      return { release: job.release };
    },
    memAvailableGiB: async () => (await sampleHost()).memAvailableGiB,
    diskFreeGiB: async (path) => {
      const s = await statfs(path);
      return (s.bavail * s.bsize) / 1024 ** 3;
    },
    tracemakerBusy: () => sysinfo.processRunning("tracemaker"),
    log: note,
    signal: ctx.signal,
  };
}
