/**
 * board_route: the layout stage as one durable tool. `check` (preflight) -> `place` (KiCadRoutingTools seeds, each gated
 * on native courtyard DRC) -> `rank` (route the kept seeds, rank by open / A8 / A7) -> `route` (TraceMaker + KRT finish,
 * hedged), or `auto` for the remaining stages. Every stage writes `WS/<stage>/result.json` and ends PASS / FAIL / STOP.
 *
 * Engines (KiCadRoutingTools, TraceMaker) are programs the workflow runs, found through settings/env and the router
 * registry; nothing here installs them. Heavy stages are admitted by the resource governor (`router`, and `tracemaker`
 * for the one engine that runs alone). Overlaps `route_run` (an autorouter call on the live board) and `pcb_place`
 * (single parts): board_route is the staged flow with seeds, gates, ranking and records.
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { layout, readJsonOrNull } from "@fabdesk/board-workflow";
type FlowState = layout.FlowState;
type LayoutHost = layout.LayoutHost;
type LayoutSpec = layout.LayoutSpec;
type StageOutcome = layout.StageOutcome;
const {
  finishFlow,
  initFlow,
  layoutDir,
  loadFlow,
  nextStep,
  nodeRun,
  prepareLayout,
  runAuto,
  stageCheck,
  statusLines,
  stagePlace,
  stageRank,
  stageRoute,
  FlowError,
} = layout;
import { durable } from "../durable";
import { boardMemGiB, governor, sampleHost, type ResourceClass } from "../resources";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { requireKicad } from "./common";

/** Where KiCadRoutingTools lives: `FABDESK_KRT_DIR` (a build with `src/plugins` and `venv/bin/python`). */
export const krtDir = (env: NodeJS.ProcessEnv = process.env) => env["FABDESK_KRT_DIR"] || null;

export function layoutHost(ctx: ToolContext, kicadCli: string | null, env: NodeJS.ProcessEnv = process.env): LayoutHost {
  const note = (s: string) => ctx.progress(0, s);
  const drc = async (board: string, outFile: string, opts: { parity: boolean; refill: boolean }) => {
    const cli = await requireKicad(ctx);
    return ctx.services.kicad.runDrc(cli, { board, outFile, severity: "all", schematicParity: opts.parity, refillZones: opts.refill, signal: ctx.signal });
  };
  return {
    tools: {
      krt: krtDir(env),
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
    tracemakerBusy: async () => spawnSync("pgrep", ["-x", "tracemaker"]).status === 0,
    log: note,
    signal: ctx.signal,
  };
}

function describe(o: StageOutcome, st: FlowState, stage: string): string {
  return [o.verdict, ...o.lines, "", `next: ${nextStep(st).text}`, `record: ${join(st.ws, stage, "result.json")}`].join("\n");
}

export const board_route = defineTool({
  name: "board_route",
  toolset: "board",
  title: "Layout stages: check, place, rank, route",
  description:
    "The layout stage of a board. check: seconds, fail-fast preflight (engines present, disk, fixed anchors, courtyards, groups, plans, pairs). place: KiCadRoutingTools seeds, each gated on KiCad courtyard DRC and fixed parts unmoved (minutes). rank: route the kept seeds and rank by open connections, then A8 pair nets, then A7 width nets (10-20 min). route: best seed through TraceMaker and KRT finishing, hedged; STOP when too many connections are open (that is a placement problem: change groups, then place again) (15-25 min). auto: the remaining stages up to `until`. status: stages, figures, next step; `finish` records the outcome. Each stage writes WS/<stage>/result.json and ends PASS, FAIL <reason> or STOP <decision for you>. The route stage's board (result.board, flow.json best_board) is the last mile's input. Requires board_check to have onboarded the board; the groups and keep-outs it proposes are in .fabdesk/board/layout/ for you to edit. Engines are not installed here: TraceMaker via Settings > Routers, KiCadRoutingTools via FABDESK_KRT_DIR. One TraceMaker job runs at a time on the machine.",
  inputSchema: {
    action: z.enum(["check", "place", "rank", "route", "auto", "status"]).describe("The stage to run, or status."),
    workspace: z.string().max(300).optional().describe("Workspace folder, relative to the project; default .fabdesk/board/layout/ws."),
    spec: z.string().max(300).optional().describe("A layout spec file (project-relative) to start the workspace from, instead of the one derived from the board."),
    refresh: z.boolean().default(false).describe("check only: derive the layout spec and base again from the board and start a fresh workspace (discards the old workspace and its seeds)."),
    full: z.boolean().default(false).describe("check only: also measure A3/A4/A5/A9 on the base (one DRC run with parity)."),
    seeds: z.string().regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/).default("0-7").describe("place: seed list/range, e.g. 0-7 or 2,5,9-11."),
    jobs: z.number().int().min(1).max(8).default(4).describe("place/rank: parallel jobs."),
    all: z.boolean().default(false).describe("rank: route every gated seed, not only the kept ones."),
    until: z.enum(["check", "place", "rank", "route"]).default("route").describe("auto: the last stage to run."),
    finish: z.enum(["success", "failed", "blocked"]).optional().describe("status: record the outcome of this layout run."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  longRunning: true,
  handler: durable("board_route", async (args, ctx) => {
    const project = ctx.requireProject();
    const wsRel = args.workspace ?? join(".fabdesk/board/layout", "ws");
    const ws = resolve(project.dir, wsRel);
    const inside = relative(project.dir, ws);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new ToolError("workspace must be inside the project", "invalid_args");
    try {
      const flowJson = await readJsonOrNull<FlowState>(join(ws, "flow.json"));
      let st: FlowState | null = flowJson;
      const host = layoutHost(ctx, (await ctx.services.kicad.resolveCli())?.path ?? null);
      if (args.action === "check" && (!st || args.refresh)) {
        let spec: LayoutSpec;
        let specPath: string;
        if (args.spec) {
          specPath = resolve(project.dir, args.spec);
          const s = await readJsonOrNull<LayoutSpec>(specPath);
          if (!s) throw new ToolError(`cannot read the layout spec ${args.spec}`, "invalid_args");
          spec = s;
        } else ({ spec, specPath } = await prepareLayout(project.dir, { refresh: args.refresh, name: project.name }));
        if (st) {
          if (relative(layoutDir(project.dir), ws).startsWith("..")) throw new ToolError("refresh only replaces a workspace under .fabdesk/board/layout", "precondition");
          await rm(ws, { recursive: true, force: true });
        }
        await mkdir(ws, { recursive: true });
        st = await initFlow(ws, spec, specPath);
      }
      if (!st) st = await loadFlow(ws);
      if (args.action === "status") {
        const text = [...statusLines(st), "", `next: ${nextStep(st).text}`, ...(args.finish ? [await finishFlow(st, args.finish)] : [])].join("\n");
        return { text, json: { action: "status", stages: st.stages, best_seed: st.best_seed, best_board: st.best_board, finished: st.finished, next: nextStep(st).stage } };
      }
      const state = st;
      if (args.action === "auto") {
        const r = await runAuto(host, state, { seeds: args.seeds, jobs: args.jobs, all: args.all, until: args.until });
        const last = r.ran[r.ran.length - 1];
        const lines = r.ran.flatMap((x) => [`== ${x.stage}`, x.outcome.verdict, ...x.outcome.lines]);
        return {
          text: [...lines, "", ...(last ? [`next: ${nextStep(state).text}`] : ["nothing to run: every stage up to " + args.until + " already passed"])].join("\n"),
          json: { action: "auto", ok: !r.stopped, stopped: r.stopped?.verdict ?? null, ran: r.ran.map((x) => ({ stage: x.stage, verdict: x.outcome.verdict })), best_board: state.best_board },
        };
      }
      const o =
        args.action === "check"
          ? await stageCheck(host, state, { full: args.full })
          : args.action === "place"
            ? await stagePlace(host, state, { seeds: args.seeds, jobs: args.jobs })
            : args.action === "rank"
              ? await stageRank(host, state, { jobs: args.jobs, all: args.all })
              : await stageRoute(host, state);
      return {
        text: describe(o, state, args.action),
        json: { action: args.action, ok: o.ok, verdict: o.verdict, result: o.result, ...(o.board ? { board: o.board } : {}), record: join(state.ws, args.action, "result.json"), workspace: state.ws },
      };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      if (e instanceof FlowError) throw new ToolError(e.message, "precondition");
      throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
    }
  }),
});

export const boardRouteTools = [board_route];
