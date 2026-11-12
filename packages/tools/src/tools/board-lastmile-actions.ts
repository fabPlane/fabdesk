/**
 * The last-mile actions of `board_route`: a workspace (`.fabdesk/board/lastmile/<name>`) holds the accepted steps of one
 * board. `try` runs alternatives in parallel from the current board, scores every whole board (A1-A9 on a native DRC with
 * refilled zones) and keeps the best one that passes the gate; a step that does not improve the whole board is undone.
 * `accept` hands the bench's current board to `adoptCandidate` (one KiCad commit over IPC, `origin.json` beside the candidate).
 *
 * Engines: pair tightening (`tighten`) is native TypeScript. Router steps (finish, taps, pairs, fill) go to what the
 * host already has: TraceMaker from the router registry, else the bridge's fab_router / Freerouting, under the resource
 * governor. Steps that need a rip-up or placement helper (leg, blockers, a7, shorts, reroute, bundle, nudge, turn) report
 * that helper as unavailable (`board_edit` repair uses the `finish` step).
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lastmile as L, locateProject, onboard, parseBoard, profile, readRequirements, type Requirements } from "@fabdesk/board-workflow";
import { adoptCandidate, designFileHashes } from "../board-adopt";
import { PROJECT_FILES } from "../fs";
import { boardMemGiB, governor } from "../resources";
import { runTraceMaker } from "../routers";
import { ToolError, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad, runLiveDrc } from "./common";

export const LASTMILE_ACTIONS = ["new", "try", "loop", "why", "crossings", "fit", "pairs", "validate", "accept", "undo", "view", "info", "prune"] as const;

export const LASTMILE_DEFAULT_WORKSPACE = ".fabdesk/board/lastmile/main";

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

export async function openBench(ctx: ToolContext, ws: string, req: Requirements) {
  const cli = await requireKicad(ctx);
  const drc: L.DrcFn = async ({ board, parity, outFile, signal }) => {
    const r = await runLiveDrc(ctx, cli, { board, outFile, parity, refill: true, signal });
    return { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
  };
  return {
    ws,
    deps: (router: string, onLine?: (l: string) => void) => ({
      scorer: L.createScorer(req, drc),
      engine: createEngine(ctx, req, drc, router),
      signal: ctx.signal,
      ...(onLine ? { onLine } : {}),
    }),
  };
}

export async function runLastmile(a: LastmileArgs, ctx: ToolContext, wsPath: string): Promise<ToolOutput> {
    const project = ctx.requireProject();
    const req = await requirementsFor(ctx, a.pcb);
    const lines: string[] = [];
    const log = (l: string) => {
      lines.push(l);
      ctx.progress(0.5, l);
    };
    const { ws, deps } = await openBench(ctx, wsPath, req);
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
          const svg = L.renderBoardSvg(board, { window: a.box, side: a.side, ...(a.nets ? { nets: a.nets } : {}), opens: sc.opens, labels: true, title: `${basename(ws)} step ${bench.pointer}` });
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
}

/** What `runLastmile` reads from the tool's input. */
export interface LastmileArgs {
  action: (typeof LASTMILE_ACTIONS)[number];
  actions?: string[] | undefined;
  template?: string | undefined;
  pairs?: string | undefined;
  why: boolean;
  nets?: string[] | undefined;
  refs?: string | undefined;
  items?: string[] | undefined;
  box?: [number, number, number, number] | undefined;
  side: "F" | "B" | "both";
  candidate?: string | undefined;
  adopt: boolean;
  reason?: string | undefined;
  router: string;
  noAccept: boolean;
  slackA8: number;
  jobs?: number | undefined;
  budget?: number | undefined;
  maxRounds: number;
  pcb?: string | undefined;
}

/** The bench's status lines and figures, for `status` on a last-mile workspace. */
export async function lastmileStatus(ctx: ToolContext, wsPath: string): Promise<{ text: string; json: Record<string, unknown> }> {
  const req = await requirementsFor(ctx);
  const { ws, deps } = await openBench(ctx, wsPath, req);
  const bench = await L.Bench.open(ws, deps("fab_router"));
  const sc = await bench.scoreDir(bench.dir);
  const left = [`open nets: ${bench.openNets(sc).join(", ") || "none"}`, `DRC: ${JSON.stringify(sc.figures.drc)}`];
  return {
    text: [...bench.statusLines(), ...left].join("\n"),
    json: { step: bench.pointer, figures: bench.figures, history: bench.state.history.map((h) => ({ action: h.action, figures: h.figures })) },
  };
}
