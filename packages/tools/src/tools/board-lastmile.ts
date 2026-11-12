/**
 * board_lastmile: the last mile of a routed board, as one tool (it is to be folded into `board_route` by the
 * orchestrator; the action vocabulary and workspace layout are this file's own until then).
 *
 * A workspace (`.fabdesk/board/lastmile/<ws>`) holds the accepted steps of one board. `try` runs alternatives in
 * parallel from the current board, scores every whole board (A1-A9 on a native DRC with refilled zones) and keeps the
 * best one that passes the gate; a step that does not improve the whole board is undone. `accept` hands the bench's
 * current board to `adoptCandidate` (one KiCad commit over IPC, `origin.json` beside the candidate).
 *
 * Engines: pair tightening (`tighten`) is native TypeScript. Router steps (finish, taps, pairs, fill) go to what the
 * host already has: TraceMaker from the router registry, else the bridge's fab_router / Freerouting, under the resource
 * governor. Steps that need a rip-up or placement helper (leg, blockers, a7, shorts, reroute, bundle, nudge, turn) report
 * that helper as unavailable until the layout stage provides it.
 *
 * Overlaps: replaces `verify_drc` as the judge of a routing step and the unroute/route_run/verify loop an agent
 * otherwise hand-rolls; `route_run` stays the first full route.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod/v4";
import { lastmile as L, locateProject, onboard, parseBoard, profile, readRequirements, type Requirements } from "@fabdesk/board-workflow";
import { adoptCandidate, designFileHashes } from "../board-adopt";
import { durable } from "../durable";
import { PROJECT_FILES } from "../fs";
import { boardMemGiB, governor } from "../resources";
import { runTraceMaker } from "../routers";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { ok, requireKicad } from "./common";

const ACTIONS = ["new", "try", "loop", "status", "why", "crossings", "fit", "pairs", "validate", "accept", "undo", "view", "info", "prune"] as const;

const wsDir = (projectDir: string, name: string) => join(projectDir, ".fabdesk", "board", "lastmile", name);

async function requirementsFor(ctx: ToolContext, pcb?: string): Promise<Requirements> {
  const project = ctx.requireProject();
  let req = await readRequirements(project.dir);
  if (!req) {
    await onboard(project.dir, { refresh: true, ...(pcb ? { pcb } : {}), name: project.name });
    req = await readRequirements(project.dir);
  }
  if (!req) throw new ToolError("no board requirements (board_check onboards the board first)", "precondition");
  return req;
}

/** Router steps through what the host has; pair tightening natively. */
function createEngine(ctx: ToolContext, req: Requirements, drc: L.DrcFn, router: string): L.StepEngine {
  return {
    async run(step: L.Step, input): Promise<L.StepOutcome> {
      if (step.type === "pairfix") return L.runTighten({ step, input, req, drc });
      if (step.type === "repair" || step.type === "nudge")
        return { error: `${step.type} step: the rip-up / placement helper it needs is not available in this build (layout stage)` };
      if (input.pcb !== PROJECT_FILES.boardPcb) return { error: `routing steps work on ${PROJECT_FILES.boardPcb}; this board is ${input.pcb}` };
      const which = step.type === "fill" && step.router ? step.router : router;
      await L.copyBoardFolder(input.cur, input.out);
      const cls = which === "tracemaker" ? "tracemaker" : "router";
      const job = await governor().admit({
        cls,
        label: `lastmile ${step.type} ${which}`,
        paths: [input.out],
        signal: input.signal,
        memGiB: await boardMemGiB([join(input.cur, input.pcb)]),
      });
      try {
        const timeoutMs = 600_000;
        if (which === "tracemaker") {
          const binary = ctx.services.routers?.executable("tracemaker");
          if (!binary) return { error: "TraceMaker is not installed (Settings → Routers)" };
          const s = await runTraceMaker({ binary, snapshotDir: input.out, timeoutMs, signal: input.signal });
          await copyFile(join(input.out, "tracemaker", "routed.kicad_pcb"), join(input.out, input.pcb));
          return { dir: input.out, info: { router: which, message: s.message } };
        }
        if (which !== "fab_router" && which !== "freerouting") return { error: `router ${which} is not available here (fab_router, freerouting, tracemaker)` };
        const s = await ctx.services.design.route(input.out, { router: which, maxTimeMs: timeoutMs }, { signal: input.signal });
        return { dir: input.out, info: { router: which, message: s.message } };
      } finally {
        job.release();
      }
    },
  };
}

async function openBench(ctx: ToolContext, name: string, req: Requirements) {
  const project = ctx.requireProject();
  const cli = await requireKicad(ctx);
  const drc: L.DrcFn = async ({ board, parity, outFile, signal }) => {
    const r = await ctx.services.kicad.runDrc(cli, { board, outFile, severity: "project", schematicParity: parity, refillZones: true, ...(signal ? { signal } : {}) });
    return { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
  };
  return {
    ws: wsDir(project.dir, name),
    deps: (router: string, onLine?: (l: string) => void) => ({
      scorer: L.createScorer(req, drc),
      engine: createEngine(ctx, req, drc, router),
      signal: ctx.signal,
      ...(onLine ? { onLine } : {}),
    }),
  };
}

export const board_lastmile = defineTool({
  name: "board_lastmile",
  toolset: "board",
  title: "Last mile of a routed board: try, judge, keep or undo",
  description:
    "The last mile of a routed board, in a workspace of accepted steps. new: start from the project's board (scored). try: run actions in parallel from the current board, score each whole board (A1-A9, native DRC with refilled zones), accept the best one that passes the gate (fewer opens, DRC errors, A7/A8 nets; no new DRC class; no failing pair worse), leave the board unchanged otherwise. Actions chain with '+': finish, rip, taps, leg, blockers:R, window:X0,Y0,X1,Y1, a7, shorts, tighten[:REGEX], reroute[:REGEX], mirror, pairs, pairs-all, bundle:REGEX, fill:ROUTER, nudge, turn (an unknown name lists the vocabulary). Order: rip, taps, pairs-all, leg | blockers:1.0, a7, bundle per pair bundle, pairs, validate; then crossings, fit, nudge. loop: one candidate per failing pair from a template with {pair}. status: figures and steps. why: what walls each open end. pairs: per-pair coupled share and each uncoupled mm by cause (loose, on_pad, between, escape, apart). crossings: parts whose connections cross and the rotation that fixes it. fit: placement dry run. validate: full proof with schematic parity. accept: adopt the current board into the project (one KiCad commit, checkpointed). undo, view (SVG window), info (parts and nets), prune (delete candidate folders). Long actions keep running as a board job (board_job).",
  inputSchema: {
    action: z.enum(ACTIONS),
    ws: z.string().regex(/^[\w.-]+$/).max(60).default("main").describe("Workspace name."),
    actions: z.array(z.string().max(300)).max(12).optional().describe("try: the actions to run in parallel, e.g. ['leg', 'blockers:1.0'] or ['taps+a7']."),
    template: z.string().max(300).optional().describe("loop: action template with {pair}, e.g. 'tighten:{pair}'."),
    pairs: z.string().max(200).optional().describe("pairs / loop: only pairs whose P or N net matches this regex."),
    why: z.boolean().default(true).describe("pairs: split each uncoupled mm by cause."),
    nets: z.array(z.string()).max(60).optional().describe("why: nets to inspect (default every open net); view: nets to highlight."),
    refs: z.string().max(400).optional().describe("crossings: only these references, comma separated."),
    items: z.array(z.string()).max(30).optional().describe("info: part references or net regexes."),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("view: window X0 Y0 X1 Y1 in mm."),
    side: z.enum(["F", "B", "both"]).default("both"),
    candidate: z.string().optional().describe("accept: an earlier try's folder to accept after the gate re-runs on it (no re-route)."),
    adopt: z.boolean().default(true).describe("accept: also write the current board into the project."),
    reason: z.string().max(200).optional().describe("accept: what the change is, for the checkpoint."),
    router: z.string().default("fab_router").describe("Router for finish/taps/pairs steps: fab_router, freerouting or tracemaker."),
    noAccept: z.boolean().default(false),
    slackA8: z.number().int().min(0).default(0),
    jobs: z.number().int().min(1).max(8).optional(),
    budget: z.number().positive().optional().describe("Seconds per action; default max(180, 6 per open, up to 1800)."),
    maxRounds: z.number().int().min(1).max(20).default(6),
    pcb: z.string().optional().describe("new: board file in the project."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  scope: "project",
  longRunning: true,
  handler: durable("board_lastmile", async (a, ctx): Promise<import("../registry").ToolOutput> => {
    const project = ctx.requireProject();
    const req = await requirementsFor(ctx, a.pcb);
    const lines: string[] = [];
    const log = (l: string) => {
      lines.push(l);
      ctx.progress(0.5, l);
    };
    const { ws, deps } = await openBench(ctx, a.ws, req);
    const mk = () => deps(a.router, log);
    try {
      if (a.action === "new") {
        const files = await locateProject(project.dir, a.pcb);
        const origin = await designFileHashes(project.dir);
        const { bench, line } = await L.Bench.create(ws, project.dir, basename(files.pcb), mk(), { project: project.dir, originFiles: origin });
        return ok(line + `\nworkspace ${bench.ws}`, { ws: bench.ws, figures: bench.figures });
      }
      const bench = await L.Bench.open(ws, mk());
      switch (a.action) {
        case "try": {
          if (!a.actions?.length) throw new ToolError("try needs actions, e.g. ['leg', 'blockers:1.0']", "invalid_args");
          const r = await bench.try(a.actions, { noAccept: a.noAccept, slackA8: a.slackA8, ...(a.jobs ? { jobs: a.jobs } : {}), ...(a.budget ? { budget: a.budget } : {}) });
          return ok(r.lines.join("\n"), { accepted: r.accepted, step: r.pointer, figures: r.figures, candidates: r.candidates.map((c) => ({ name: c.name, wall_s: c.wall_s, figures: c.figures, rejected: c.rejected, dir: c.dir })) });
        }
        case "loop": {
          if (!a.template?.includes("{pair}")) throw new ToolError("loop needs a template with {pair}, e.g. 'tighten:{pair}'", "invalid_args");
          const out = await bench.loop(a.template, { ...(a.pairs ? { pairs: a.pairs } : {}), maxRounds: a.maxRounds, padBoxes: async (dir, nets) => {
              const ps = parseBoard(await readFile(join(dir, bench.state.pcb), "utf8")).pads.filter((q) => nets.includes(q.net));
              return ps.length ? [Math.min(...ps.map((q) => q.x)) - 1, Math.min(...ps.map((q) => q.y)) - 1, Math.max(...ps.map((q) => q.x)) + 1, Math.max(...ps.map((q) => q.y)) + 1] : null;
            }, ...(a.jobs ? { jobs: a.jobs } : {}), ...(a.budget ? { budget: a.budget } : {}) });
          return ok(out.join("\n"), { step: bench.pointer, figures: bench.figures });
        }
        case "status": {
          const sc = await bench.scoreDir(bench.dir);
          const left = [`open nets: ${bench.openNets(sc).join(", ") || "none"}`, `DRC: ${JSON.stringify(sc.figures.drc)}`];
          return ok([...bench.statusLines(), ...left].join("\n"), { step: bench.pointer, figures: bench.figures, history: bench.state.history.map((h) => ({ action: h.action, figures: h.figures })) });
        }
        case "why": {
          const sc = await bench.scoreDir(bench.dir);
          const board = parseBoard(await readFile(bench.board, "utf8"));
          return ok(L.whyLines(L.whyOpen(board, sc.opens, a.nets ?? null)).join("\n"));
        }
        case "crossings": {
          const board = parseBoard(await readFile(bench.board, "utf8"));
          const anchors = new Set(req.mechanical.anchors.map((x) => x.reference));
          const rows = L.findCrossings(board, {
            ground: profile(req.acceptance).ground,
            fixed: (r) => anchors.has(r) || board.footprints.get(r)?.locked === true || /_(J|SW)\d|^FIT_/.test(r),
            ...(a.refs ? { refs: new Set(a.refs.split(",")) } : {}),
          });
          return ok(L.crossingLines(rows).join("\n"), { rows });
        }
        case "pairs": {
          const board = parseBoard(await readFile(bench.board, "utf8"));
          const m = L.measurePairs(board, L.classesAndPairs(req, a.pairs), profile(req.acceptance).copper, a.why);
          return ok(L.measureLines(m, a.why).join("\n") || "no pairs on this board", { pairs: m });
        }
        case "fit":
          throw new ToolError("fit (placement dry run) needs the placement helper of the layout stage, which is not available in this build", "unavailable");
        case "validate": {
          const rec = await bench.validate();
          return ok(JSON.stringify(rec, null, 1), rec);
        }
        case "accept": {
          if (a.candidate) {
            const r = await bench.acceptDir(a.candidate, { slackA8: a.slackA8 });
            lines.push(...r.lines);
            if (!r.ok) throw new ToolError(lines.join("\n"), "precondition");
          }
          if (!a.adopt) return ok(lines.concat(`step ${bench.pointer}: ${L.figureLine(bench.figures)}`).join("\n"), { step: bench.pointer });
          if (bench.pointer === 0) throw new ToolError("nothing accepted yet: the bench is at the start board", "precondition");
          const origin = (bench.state.meta?.["originFiles"] ?? {}) as Record<string, string>;
          await writeFile(join(bench.dir, "origin.json"), JSON.stringify({ project: project.dir, files: origin }, null, 1) + "\n");
          const r = await adoptCandidate(ctx, { candidate: bench.candidateBoard(), reason: a.reason ?? `last mile: ${bench.state.history.slice(1, bench.pointer + 1).map((h) => h.action).join(", ")}`.slice(0, 190) });
          return ok(r.text, r.data);
        }
        case "undo":
          return ok(await bench.undo(), { step: bench.pointer });
        case "view": {
          if (!a.box) throw new ToolError("view needs box: [X0, Y0, X1, Y1] in mm", "invalid_args");
          const sc = await bench.scoreDir(bench.dir);
          const board = parseBoard(await readFile(bench.board, "utf8"));
          const svg = L.renderBoardSvg(board, { window: a.box, side: a.side, ...(a.nets ? { nets: a.nets } : {}), opens: sc.opens, labels: true, title: `${a.ws} step ${bench.pointer}` });
          const out = join(bench.ws, "views", `s${bench.pointer}-${a.box.join("-")}-${a.side}.svg`);
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, svg);
          let png: string | null = null;
          try {
            const r = await ctx.services.kicad.rasterizeSvg(svg, { maxWidth: 1400 });
            png = out.replace(/\.svg$/, ".png");
            await writeFile(png, r.png);
          } catch {
            /* the SVG is the view */
          }
          return ok(png ?? out, { svg: out, png });
        }
        case "info": {
          if (!a.items?.length) throw new ToolError("info needs items: part references or net regexes", "invalid_args");
          return ok(L.infoLines(parseBoard(await readFile(bench.board, "utf8")), a.items).join("\n"));
        }
        case "prune":
          return ok(await bench.prune());
      }
      return ok(L.actionHelp().join("\n"));
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
    }
  }),
});

export const boardLastmileTools = [board_lastmile];
