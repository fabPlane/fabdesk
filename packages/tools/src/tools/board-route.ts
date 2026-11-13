/**
 * board_route: the layout stage as one durable tool. `check` (preflight) -> `place` (KiCadRoutingTools seeds, each gated
 * on native courtyard DRC) -> `rank` (route the kept seeds, rank by open / A8 / A7) -> `route` (TraceMaker + KRT finish,
 * hedged), or `auto` for the remaining stages. Every stage writes `WS/<stage>/result.json` and ends PASS / FAIL / STOP.
 *
 * Engines (KiCadRoutingTools, TraceMaker) are programs the workflow runs, found through settings/env and the router
 * registry; a missing one installs on first use through the registry (board-host `engineEnsurer`; Settings
 * autoInstallEngines turns that off, and a set override is used as given). Heavy stages are admitted by the resource governor (`router`, and `tracemaker`
 * for the one engine that runs alone). Overlaps `route_run` (an autorouter call on the live board) and `pcb_place`
 * (single parts): board_route is the staged flow with seeds, gates, ranking and records.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import { applyClean, cleanBytes, cleanLines, cleanPlan, layout, locateProject, readJsonOrNull } from "@fabdesk/board-workflow";
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
  prepareLayout,
  runAuto,
  stageCheck,
  statusLines,
  stagePlace,
  stageRank,
  stageRoute,
  FlowError,
} = layout;
import { durable, listDurableJobs } from "../durable";
import { jailPath } from "../fs";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { LASTMILE_ACTIONS, LASTMILE_DEFAULT_WORKSPACE, lastmileStatus, runLastmile } from "./board-lastmile-actions";

export { krtDir, layoutHost } from "./board-host";
import { layoutHost } from "./board-host";
import { adoptCandidate } from "../board-adopt";

function describe(o: StageOutcome, st: FlowState, stage: string): string {
  return [o.verdict, ...o.lines, "", `next: ${nextStep(st).text}`, `record: ${join(st.ws, stage, "result.json")}`].join("\n");
}

const LAYOUT_ACTIONS = ["check", "place", "rank", "route", "auto", "status", "courtyards", "clean"] as const;
const LASTMILE = new Set<string>(LASTMILE_ACTIONS);
const LAYOUT_DEFAULT_WORKSPACE = join(".fabdesk/board/layout", "ws");

/**
 * A `workspace` argument as an absolute folder: project-relative, and (by real path, so a symlink cannot lead out) inside
 * `<project>/.fabdesk/board/`, where every board stage writes until a candidate is adopted.
 */
export async function boardWorkspace(projectDir: string, rel: string): Promise<string> {
  const inProject = await jailPath(projectDir, rel);
  // the root itself must be the project's (not a symlink out of it), and exist so its real path can be compared
  const root = await jailPath(projectDir, join(".fabdesk", "board"));
  await mkdir(root, { recursive: true });
  try {
    return await jailPath(root, inProject);
  } catch {
    throw new ToolError(`workspace must be a folder under .fabdesk/board/ in the project: ${rel}`, "invalid_args");
  }
}

const ROUTE_INPUT = {
  action: z
    .enum([...LAYOUT_ACTIONS, ...LASTMILE_ACTIONS])
    .describe("Layout: check, place, rank, route, auto, status, courtyards. Last mile: new, try, loop, sweep, why, crossings, fit, pairs, validate, accept, undo, view, info, prune. Housekeeping: clean (every board stage's reproducible copies in .fabdesk/board/; dry run unless apply)."),
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
  actions: z.array(z.string().max(300)).max(12).optional().describe("Last-mile try: the actions to run in parallel, e.g. ['leg', 'blockers:1.0'] or ['taps+a7']; fit: one nudge:/turn: action."),
  template: z.string().max(300).optional().describe("Last-mile loop: action template with {pair}, e.g. 'tighten:{pair}'."),
  pairs: z.string().max(200).optional().describe("Last-mile pairs / loop: only pairs whose P or N net matches this regex."),
  why: z.boolean().default(true).describe("Last-mile pairs: split each uncoupled mm by cause."),
  nets: z.array(z.string()).max(60).optional().describe("Last-mile why: nets to inspect (default every open net); view: nets to highlight."),
  refs: z.string().max(400).optional().describe("Last-mile crossings: only these references; sweep: the parts to sweep (comma separated)."),
  items: z.array(z.string()).max(30).optional().describe("Last-mile info: part references or net regexes."),
  box: z.array(z.number()).length(4).optional()  /* not a tuple: Codex drops tools with array-form `items` (board-edit.ts `nums`) */.describe("Last-mile view / fit: window X0 Y0 X1 Y1 in mm."),
  side: z.enum(["F", "B", "both"]).default("both").describe("Last-mile view: board side."),
  candidate: z.string().optional().describe("Last-mile accept: an earlier try's folder to accept after the gate re-runs on it (no re-route)."),
  adopt: z.boolean().default(true).describe("Last-mile accept: also write the current board into the project."),
  reason: z.string().max(200).optional().describe("Last-mile accept: what the change is, for the checkpoint."),
  router: z.string().default("fab_router").describe("Last-mile router for `finish` when KiCadRoutingTools is not configured: fab_router, freerouting or tracemaker (fill:ROUTER names its own)."),
  span: z.number().positive().max(10).optional().describe("Last-mile sweep: half-width of the pose grid round each part, mm (default 1)."),
  step: z.number().positive().max(5).optional().describe("Last-mile sweep: grid step, mm (default 0.5)."),
  rotations: z.enum(["keep", "flip", "all"]).default("flip").describe("Last-mile sweep: rotations tried at each pose."),
  then: z.string().max(300).optional().describe("Last-mile sweep: repair chain after each pose, e.g. 'blockers:1.0'."),
  noAccept: z.boolean().default(false).describe("Last-mile try: score the candidates but do not accept."),
  slackA8: z.number().int().min(0).default(0).describe("Last-mile try/accept: A8 nets the gate may let get worse."),
  budget: z.number().positive().optional().describe("Last-mile: seconds per action; default max(180, 6 per open, up to 1800)."),
  maxRounds: z.number().int().min(1).max(20).default(6).describe("Last-mile loop: rounds."),
  pcb: z.string().optional().describe("Last-mile new: board file in the project."),
  margin: z.number().min(0).max(2).default(0.25).describe("Courtyards: margin round the pad extent for an added courtyard (IPC-7351 nominal 0.25 mm)."),
  halo: z.string().max(400).optional().describe("Courtyards: comma-separated references whose courtyard becomes an escape halo (pad extent + haloMm) in the layout workspace's base board only (placement room round escape-heavy parts; never the fab board)."),
  haloMm: z.number().min(0).max(5).default(0.8).describe("Courtyards: halo size round the pads."),
  apply: z.boolean().default(false).describe("Clean: delete what the dry run lists (refused while a board job or routing runs in this project). Default: list only."),
  keep: z.number().int().min(1).max(50).default(3).describe("Clean: newest review runs, adopt backups, upgraded copies and Gerber check runs to keep."),
};
type RouteArgs = z.infer<z.ZodObject<typeof ROUTE_INPUT>>;

export const board_route = defineTool({
  name: "board_route",
  toolset: "board",
  title: "Layout and last mile: check, place, rank, route, tighten and finish",
  description:
    "Everything between a placed board and a routed one. Two stages share the `workspace` folder argument (project-relative; default .fabdesk/board/layout/ws for the layout stages, .fabdesk/board/lastmile/main for the last mile). LAYOUT (needs board_check to have onboarded the board; the groups and keep-outs it proposes are in .fabdesk/board/layout/ for you to edit): check: seconds, fail-fast preflight (engines present, disk, fixed anchors, courtyards, groups, plans, pairs). place: KiCadRoutingTools seeds, each gated on KiCad courtyard DRC and fixed parts unmoved (minutes). rank: route the kept seeds and rank by open connections, then A8 pair nets, then A7 width nets (10-20 min). route: best seed through TraceMaker and KRT finishing, hedged; STOP when too many connections are open (that is a placement problem: change groups, then place again) (15-25 min). auto: the remaining layout stages up to `until`. courtyards: a courtyard (pad extent + margin) for every footprint with pads and none, and inverted courtyard rectangles put right, written into the board (the layout check flags parts without one: courtyard DRC cannot see them); with halo, escape halos on the layout base only (placement room round escape-heavy parts). status: stages, figures and next step (`finish` records the outcome); on a last-mile workspace, the bench figures and steps. Each layout stage writes WS/<stage>/result.json and ends PASS, FAIL <reason> or STOP <decision for you>. The route stage's board is the last mile's input. LAST MILE (a workspace of accepted steps on a routed board): new: start from the project's board (scored). try: run `actions` in parallel from the current board, score each whole board (A1-A9, native DRC with refilled zones), accept the best that passes the gate (fewer opens, DRC errors, A7/A8 nets; no new DRC class; no failing pair worse), leave the board unchanged otherwise. Actions chain with '+': finish, rip, taps, leg, blockers:R, window:X0,Y0,X1,Y1, a7, shorts, legs:R, tighten[:REGEX] (pair ops vias, mirror, retune, width, tighten, skew), reroute[:REGEX], mirror[:REGEX], pairs, pairs-m, pairs-all, pairs-fix, bundle:REGEX[@BOX], fence:BOX=NETREGEX, fill:ROUTER, nudge:REF@X,Y[@ROT][~R], turn:REF@ROT, plan:FILE (an unknown name lists the vocabulary). Order: rip, taps, pairs-all, leg | blockers:1.0, a7, bundle per pair bundle, pairs, validate; then crossings, fit, nudge. loop: one candidate per failing pair from a `template` with {pair} (e.g. 'reroute:{pair}+shorts+blockers:1.0+tighten'). sweep: grid of courtyard-gated poses round each of `refs` (span, step, rotations), each followed by `then`, best accepted. why: what walls each open end (KRT net_forensics) and TraceMaker's cause class of each open. pairs: per-pair coupled share and each uncoupled mm by cause (loose, on_pad, between, escape, apart). crossings: parts whose connections cross and the rotation that fixes it. fit: placement dry run of one nudge/turn action (poses or what blocks them, courtyard gate, a picture). validate: full proof with schematic parity. accept: adopt the current board into the project (one KiCad commit, checkpointed). undo, view (SVG window), info (parts and nets), prune (delete this workspace's candidate folders). HOUSEKEEPING: clean: every board stage's reproducible copies in .fabdesk/board/ (review runs beyond the newest `keep`, edit candidates that can no longer be adopted, old adopt backups, layout seeds and routes once the route stage finished, unaccepted last-mile tries, one-shot adopt inputs), each with size and reason; a dry run unless apply: true. Engines install themselves on first use: the first step that needs KiCadRoutingTools or TraceMaker downloads and sets it up (sha256-checked; KRT gets its own hash-locked Python, nothing has to be preinstalled; minutes the first time, progress lines meanwhile); board_engines shows them or installs ahead. A set TRACEMAKER_BIN / FABDESK_KRT_DIR / Settings krtDir is used as given and never installed over. Router, rip and nudge steps run KiCadRoutingTools plans; when KRT cannot be had only finish (on `router`), fill:ROUTER and the in-place pair steps run, and the others fail naming why. One TraceMaker job runs at a time on the machine; long actions keep running as a board job (board_job).",
  inputSchema: ROUTE_INPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  longRunning: true,
  // clean is a quick walk of the project's own folders: it answers directly (and so never counts itself as a running job)
  handler: (args, ctx) => (args.action === "clean" ? cleanAction(args, ctx) : routeHandler(args, ctx)),
});

const routeHandler = durable("board_route", async (args: RouteArgs, ctx: ToolContext) => {
  const project = ctx.requireProject();
  const isLastmile = LASTMILE.has(args.action);
  const inProject = (rel: string) => boardWorkspace(project.dir, rel);
  if (isLastmile) return runLastmile(args as never, ctx, await inProject(args.workspace ?? LASTMILE_DEFAULT_WORKSPACE));
  if (args.action === "courtyards") return courtyardsAction(args, ctx, inProject);
  const wsRel = args.workspace ?? LAYOUT_DEFAULT_WORKSPACE;
  const ws = await inProject(wsRel);
  const jobs = args.jobs ?? 4;
  try {
    const flowJson = await readJsonOrNull<FlowState>(join(ws, "flow.json"));
    let st: FlowState | null = flowJson;
    if (args.action === "status") {
      // a last-mile workspace (named explicitly, or the only one there is) answers with the bench's figures
      const lm = await inProject(args.workspace ?? LASTMILE_DEFAULT_WORKSPACE);
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
        specPath = await jailPath(project.dir, args.spec);
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
});

export const boardRouteTools = [board_route];

/**
 * board_route clean (the toolkit's tools/clean.py): the reproducible copies every board stage leaves in .fabdesk/board/
 * (old review runs, unadoptable edit candidates, old adopt backups, finished layout seeds, unaccepted last-mile tries),
 * listed with size and reason; `apply` deletes them, never while a board job or routing runs in the project.
 */
async function cleanAction(args: RouteArgs, ctx: ToolContext) {
  const project = ctx.requireProject();
  const plan = await cleanPlan(project.dir, { keep: args.keep });
  const lines = cleanLines(plan);
  if (!plan.remove.length) return { text: "Nothing to clean: .fabdesk/board/ holds no reproducible copies beyond what is kept.", json: { action: "clean", remove: [], kept: plan.kept, bytes: 0 } };
  if (!args.apply)
    return {
      text: ["Dry run (nothing deleted):", ...lines, `Kept: ${plan.kept.length} folder(s) still in use (candidates that can be adopted, accepted steps, the latest runs, layout in progress).`, 'board_route {"action": "clean", "apply": true} deletes the list.'].join("\n"),
      json: { action: "clean", applied: false, remove: plan.remove, kept: plan.kept, bytes: plan.bytes },
    };
  const busy = listDurableJobs(project.id).filter((j) => j.state === "running");
  const route = ctx.services.routeRuns.latest(project.id);
  if (busy.length || (route && ["queued", "running", "cancel_requested", "cancelling"].includes(route.state)))
    throw new ToolError(`clean refused: ${busy.length ? `${busy.length} board job(s) running (${busy.map((j) => j.tool).join(", ")})` : "routing is active"}; their folders may still be inputs. Wait for them (board_job), then clean.`, "precondition");
  const r = await applyClean(project.dir, plan);
  return { text: [`Removed ${r.removed} item(s), ${cleanBytes(r.bytes)}:`, ...lines.slice(1)].join("\n"), json: { action: "clean", applied: true, removed: r.removed, bytes: r.bytes, remove: plan.remove } };
}

/**
 * board_route courtyards (the toolkit's add_courtyards.py): a courtyard for every footprint with pads and none of its
 * own, and inverted courtyard rectangles put right, written into the project board (one KiCad commit through adopt);
 * with `halo`, escape halos on the layout workspace's base board instead (placement only, the fab board untouched).
 */
async function courtyardsAction(
  args: { pcb?: string | undefined; workspace?: string | undefined; margin: number; halo?: string | undefined; haloMm: number },
  ctx: ToolContext,
  inProject: (rel: string) => Promise<string>,
) {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, args.pcb);
  if (args.halo) {
    const ws = await inProject(args.workspace ?? LAYOUT_DEFAULT_WORKSPACE);
    const base = join(ws, "base", `${files.stem}.kicad_pcb`);
    const text = await readFile(base, "utf8").catch(() => null);
    if (text === null) throw new ToolError(`no layout base at ${relative(project.dir, base)}: run board_route {"action":"check"} first`, "precondition");
    const r = layout.addCourtyards(text, { margin: args.margin, halo: args.halo.split(",").map((x) => x.trim()).filter(Boolean), haloMm: args.haloMm });
    await writeFile(base, r.text);
    const hs = Object.entries(r.halos).map(([k, [w, h]]) => `${k} ${w} x ${h} mm`);
    return { text: `Layout base ${relative(project.dir, base)}: halos ${hs.join(", ") || "none (no pads on those references)"}; also ${Object.keys(r.added).length} courtyard(s) added, ${r.inverted_rects_fixed} inverted rectangle(s) fixed. Placement only: the project board is unchanged.`, json: { base: relative(project.dir, base), ...r, text: undefined } };
  }
  const text = await readFile(files.pcb, "utf8");
  const r = layout.addCourtyards(text, { margin: args.margin });
  const n = Object.keys(r.added).length;
  if (!n && !r.inverted_rects_fixed) return { text: "Every footprint with pads has a courtyard and no courtyard rectangle is inverted: nothing to change.", json: { added: {}, inverted_rects_fixed: 0 } };
  const dir = join(project.dir, ".fabdesk", "board", "layout", "courtyards");
  await mkdir(dir, { recursive: true });
  const cand = join(dir, `${files.stem}.kicad_pcb`);
  await writeFile(cand, r.text);
  const reason = `courtyards: ${n} added (pad extent + ${args.margin} mm), ${r.inverted_rects_fixed} inverted rectangle(s) fixed`;
  const ad = await adoptCandidate(ctx, { candidate: cand, board: relative(project.dir, files.pcb), reason });
  const list = Object.entries(r.added).slice(0, 12).map(([k, [w, h, l]]) => `${k} ${w} x ${h} ${l}`);
  return {
    text: [`${reason}.`, ...(n ? [`Added: ${list.join("; ")}${n > 12 ? `; ... ${n - 12} more` : ""}`] : []), ad.text].join("\n"),
    json: { added: r.added, inverted_rects_fixed: r.inverted_rects_fixed, adopt: ad.data },
  };
}
