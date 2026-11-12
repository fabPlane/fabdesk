/**
 * The layout host of the board tools: where the engines are (KiCadRoutingTools and TraceMaker from Settings → Routers,
 * or their overrides), how processes run, the DRC flavours (courtyard gate, refilled scoring) and admission by the
 * resource governor. Shared by `board_route`'s layout stages and its last mile.
 */
import { statfs } from "node:fs/promises";
import { layout, sysinfo } from "@fabdesk/board-workflow";
import { boardMemGiB, governor, sampleHost, type ResourceClass } from "../resources";
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

export function layoutHost(ctx: ToolContext, kicadCli: string | null, env: NodeJS.ProcessEnv = process.env): LayoutHost {
  const note = (s: string) => ctx.progress(0, s);
  const drc = async (board: string, outFile: string, opts: { parity: boolean; refill: boolean }) => {
    const cli = await requireKicad(ctx);
    return runLiveDrc(ctx, cli, { board, outFile, parity: opts.parity, refill: opts.refill, signal: ctx.signal });
  };
  return {
    tools: {
      krt: krtDir(env, ctx.services.settings?.().krtDir, ctx.services.routers?.executable("krt")),
      tracemaker: ctx.services.routers?.executable("tracemaker") ?? env["TRACEMAKER_BIN"] ?? null,
      kicadCli,
    },
    spawn: nodeRun,
    courtyardDrc: async (board, report) => (await drc(board, report, { parity: false, refill: false })).violations.map((v) => ({ rule: v.rule, items: v.items.map((i) => ({ description: i.description })) })),
    scoreDrc: async (board, outFile, parity) => {
      const r = await drc(board, outFile, { parity, refill: true });
      return { violations: r.violations.map((v) => ({ rule: v.rule, severity: v.severity, description: v.description })), unconnected: r.unconnected.length, parity: r.schematicParity.length };
    },
    admit: async (kind, label, paths) => {
      const job = await governor().admit({ cls: kind as ResourceClass, label, paths, signal: ctx.signal, memGiB: await boardMemGiB(paths), onWait: note });
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

