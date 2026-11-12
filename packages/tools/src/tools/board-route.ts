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
import { requireKicad, runLiveDrc } from "./common";
import { LASTMILE_ACTIONS, LASTMILE_DEFAULT_WORKSPACE, lastmileStatus, runLastmile } from "./board-lastmile-actions";

/** Where KiCadRoutingTools lives: `FABDESK_KRT_DIR` (a build with `src/plugins` and `venv/bin/python`). */
export const krtDir = (env: NodeJS.ProcessEnv = process.env) => env["FABDESK_KRT_DIR"] || null;

export function layoutHost(ctx: ToolContext, kicadCli: string | null, env: NodeJS.ProcessEnv = process.env): LayoutHost {
  const note = (s: string) => ctx.progress(0, s);
  const drc = async (board: string, outFile: string, opts: { parity: boolean; refill: boolean }) => {
    const cli = await requireKicad(ctx);
    return runLiveDrc(ctx, cli, { board, outFile, parity: opts.parity, refill: opts.refill, signal: ctx.signal });
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

const LAYOUT_ACTIONS = ["check", "place", "rank", "route", "auto", "status"] as const;
const LASTMILE = new Set<string>(LASTMILE_ACTIONS);
const LAYOUT_DEFAULT_WORKSPACE = join(".fabdesk/board/layout", "ws");

export const board_route = defineTool({
  name: "board_route",
  toolset: "board",
  title: "Layout and last mile: check, place, rank, route, tighten and finish",
  description:
    "Everything between a placed board and a routed one. Two stages share the `workspace` folder argument (project-relative; default .fabdesk/board/layout/ws for the layout stages, .fabdesk/board/lastmile/main for the last mile). LAYOUT (needs board_check to have onboarded the board; the groups and keep-outs it proposes are in .fabdesk/board/layout/ for you to edit): check: seconds, fail-fast preflight (engines present, disk, fixed anchors, courtyards, groups, plans, pairs). place: KiCadRoutingTools seeds, each gated on KiCad courtyard DRC and fixed parts unmoved (minutes). rank: route the kept seeds and rank by open connections, then A8 pair nets, then A7 width nets (10-20 min). route: best seed through TraceMaker and KRT finishing, hedged; STOP when too many connections are open (that is a placement problem: change groups, then place again) (15-25 min). auto: the remaining layout stages up to `until`. status: stages, figures and next step (`finish` records the outcome); on a last-mile workspace, the bench figures and steps. Each layout stage writes WS/<stage>/result.json and ends PASS, FAIL <reason> or STOP <decision for you>. The route stage's board is the last mile's input. LAST MILE (a workspace of accepted steps on a routed board): new: start from the project's board (scored). try: run `actions` in parallel from the current board, score each whole board (A1-A9, native DRC with refilled zones), accept the best that passes the gate (fewer opens, DRC errors, A7/A8 nets; no new DRC class; no failing pair worse), leave the board unchanged otherwise. Actions chain with '+': finish, rip, taps, leg, blockers:R, window:X0,Y0,X1,Y1, a7, shorts, tighten[:REGEX], reroute[:REGEX], mirror, pairs, pairs-all, bundle:REGEX, fill:ROUTER, nudge, turn (an unknown name lists the vocabulary). Order: rip, taps, pairs-all, leg | blockers:1.0, a7, bundle per pair bundle, pairs, validate; then crossings, fit, nudge. loop: one candidate per failing pair from a `template` with {pair}. why: what walls each open end. pairs: per-pair coupled share and each uncoupled mm by cause (loose, on_pad, between, escape, apart). crossings: parts whose connections cross and the rotation that fixes it. fit: placement dry run. validate: full proof with schematic parity. accept: adopt the current board into the project (one KiCad commit, checkpointed). undo, view (SVG window), info (parts and nets), prune (delete candidate folders). Engines are not installed here: TraceMaker via Settings > Routers, KiCadRoutingTools via FABDESK_KRT_DIR. One TraceMaker job runs at a time on the machine; long actions keep running as a board job (board_job).",
  inputSchema: {
    action: z
      .enum([...LAYOUT_ACTIONS, ...LASTMILE_ACTIONS])
      .describe("Layout: check, place, rank, route, auto, status. Last mile: new, try, loop, why, crossings, fit, pairs, validate, accept, undo, view, info, prune."),
    workspace: z.string().max(300).optional().describe("Workspace folder, relative to the project; default .fabdesk/board/layout/ws (layout) or .fabdesk/board/lastmile/main (last mile)."),
    // layout stages
    spec: z.string().max(300).optional().describe("Layout check: a layout spec file (project-relative) to start the workspace from, instead of the one derived from the board."),
    refresh: z.boolean().default(false).describe("Layout check: derive the layout spec and base again from the board and start a fresh workspace (discards the old workspace and its seeds)."),
    full: z.boolean().default(false).describe("Layout check: also measure A3/A4/A5/A9 on the base (one DRC run with parity)."),
    seeds: z.string().regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/).default("0-7").describe("Layout place: seed list/range, e.g. 0-7 or 2,5,9-11."),
    jobs: z.number().int().min(1).max(8).optional().describe("Parallel jobs: layout place/rank (default 4), last-mile try/loop (default by memory)."),
    all: z.boolean().default(false).describe("Layout rank: route every gated seed, not only the kept ones."),
    until: z.enum(["check", "place", "rank", "route"]).default("route").describe("Layout auto: the last stage to run."),
    finish: z.enum(["success", "failed", "blocked"]).optional().describe("Layout status: record the outcome of this layout run."),
    // last mile
    actions: z.array(z.string().max(300)).max(12).optional().describe("Last-mile try: the actions to run in parallel, e.g. ['leg', 'blockers:1.0'] or ['taps+a7']."),
    template: z.string().max(300).optional().describe("Last-mile loop: action template with {pair}, e.g. 'tighten:{pair}'."),
    pairs: z.string().max(200).optional().describe("Last-mile pairs / loop: only pairs whose P or N net matches this regex."),
    why: z.boolean().default(true).describe("Last-mile pairs: split each uncoupled mm by cause."),
    nets: z.array(z.string()).max(60).optional().describe("Last-mile why: nets to inspect (default every open net); view: nets to highlight."),
    refs: z.string().max(400).optional().describe("Last-mile crossings: only these references, comma separated."),
    items: z.array(z.string()).max(30).optional().describe("Last-mile info: part references or net regexes."),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("Last-mile view: window X0 Y0 X1 Y1 in mm."),
    side: z.enum(["F", "B", "both"]).default("both").describe("Last-mile view: board side."),
    candidate: z.string().optional().describe("Last-mile accept: an earlier try's folder to accept after the gate re-runs on it (no re-route)."),
    adopt: z.boolean().default(true).describe("Last-mile accept: also write the current board into the project."),
    reason: z.string().max(200).optional().describe("Last-mile accept: what the change is, for the checkpoint."),
    router: z.string().default("fab_router").describe("Last-mile router for finish/taps/pairs steps: fab_router, freerouting or tracemaker."),
    noAccept: z.boolean().default(false).describe("Last-mile try: score the candidates but do not accept."),
    slackA8: z.number().int().min(0).default(0).describe("Last-mile try/accept: A8 nets the gate may let get worse."),
    budget: z.number().positive().optional().describe("Last-mile: seconds per action; default max(180, 6 per open, up to 1800)."),
    maxRounds: z.number().int().min(1).max(20).default(6).describe("Last-mile loop: rounds."),
    pcb: z.string().optional().describe("Last-mile new: board file in the project."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  longRunning: true,
  handler: durable("board_route", async (args, ctx) => {
    const project = ctx.requireProject();
    const isLastmile = LASTMILE.has(args.action);
    const inProject = (rel: string) => {
      const dir = resolve(project.dir, rel);
      const inside = relative(project.dir, dir);
      if (inside.startsWith("..") || isAbsolute(inside)) throw new ToolError("workspace must be inside the project", "invalid_args");
      return dir;
    };
    if (isLastmile) return runLastmile(args as never, ctx, inProject(args.workspace ?? LASTMILE_DEFAULT_WORKSPACE));
    const wsRel = args.workspace ?? LAYOUT_DEFAULT_WORKSPACE;
    const ws = inProject(wsRel);
    const jobs = args.jobs ?? 4;
    try {
      const flowJson = await readJsonOrNull<FlowState>(join(ws, "flow.json"));
      let st: FlowState | null = flowJson;
      if (args.action === "status") {
        // a last-mile workspace (named explicitly, or the only one there is) answers with the bench's figures
        const lm = inProject(args.workspace ?? LASTMILE_DEFAULT_WORKSPACE);
        if ((args.workspace || !st) && (await readJsonOrNull<unknown>(join(lm, "state.json")))) {
          const r = await lastmileStatus(ctx, lm);
          return { text: r.text, json: { action: "status", stage: "lastmile", ...r.json } };
        }
      }
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
        const r = await runAuto(host, state, { seeds: args.seeds, jobs, all: args.all, until: args.until });
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
            ? await stagePlace(host, state, { seeds: args.seeds, jobs })
            : args.action === "rank"
              ? await stageRank(host, state, { jobs, all: args.all })
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
