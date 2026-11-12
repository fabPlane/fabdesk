/**
 * The last-mile actions of `board_route`: a workspace (`.fabdesk/board/lastmile/<name>`) holds the accepted steps of one
 * board. `try` runs alternatives in parallel from the current board, scores every whole board (A1-A9 on a native DRC with
 * refilled zones) and keeps the best one that passes the gate; a step that does not improve the whole board is undone.
 * `accept` hands the bench's current board to `adoptCandidate` (one KiCad commit over IPC, `origin.json` beside the candidate).
 *
 * Steps run in the library's step engine (`lastmile/engine.ts`): KiCadRoutingTools plans for the router steps, rip-up
 * and nudge before their re-route, pair operations natively, and `fill:ROUTER` on the host's routers (TraceMaker from
 * the router registry, the bridge's fab_router / Freerouting) under the resource governor. Without KRT only `finish`
 * runs (on the host router); other KRT steps fail by name. Boards of any file name work.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lastmile as L, layout, locateProject, onboard, parseBoard, profile, readRequirements, type Requirements } from "@fabdesk/board-workflow";
import { adoptCandidate, designFileHashes } from "../board-adopt";
import { PROJECT_FILES } from "../fs";
import { runTraceMaker } from "../routers";
import { ToolError, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad, runLiveDrc } from "./common";
import { layoutHost } from "./board-host";

export const LASTMILE_ACTIONS = ["new", "try", "loop", "sweep", "why", "crossings", "fit", "pairs", "validate", "accept", "undo", "view", "info", "prune"] as const;

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

/** The host's routers for `fill` steps (and `finish` when KiCadRoutingTools is missing), on `dir/board.kicad_pcb` in place. */
function hostFill(ctx: ToolContext, host: layout.LayoutHost): L.FillFn {
  return async (router, dir, { signal, timeoutMs }) => {
    if (router === "tracemaker") {
      // installed on first use when it is missing (one TraceMaker install even when parallel candidates ask)
      const tm = await layout.engineReady(host, "tracemaker");
      const binary = tm.path;
      if (!binary) throw new Error(tm.why ?? "TraceMaker is not installed (board_engines install tracemaker, or TRACEMAKER_BIN)");
      const s = await runTraceMaker({ binary, snapshotDir: dir, timeoutMs, signal });
      await copyFile(join(dir, "tracemaker", "routed.kicad_pcb"), join(dir, PROJECT_FILES.boardPcb));
      return { message: s.message };
    }
    if (router !== "fab_router" && router !== "freerouting") throw new Error(`router ${router} is not available here (fab_router, freerouting, tracemaker)`);
    const s = await ctx.services.design.route(dir, { router, maxTimeMs: timeoutMs }, { signal });
    return { message: s.message };
  };
}

export async function openBench(ctx: ToolContext, ws: string, req: Requirements) {
  const cli = await requireKicad(ctx);
  const drc: L.DrcFn = async ({ board, parity, outFile, signal }) => {
    const r = await runLiveDrc(ctx, cli, { board, outFile, parity, refill: true, signal });
    return { violations: r.violations, unconnected: r.unconnected, parity: r.schematicParity.length };
  };
  const host = layoutHost(ctx, cli.path);
  return {
    ws,
    host,
    deps: (router: string, onLine?: (l: string) => void) => {
      const scorer = L.createScorer(req, drc);
      return {
        scorer,
        engine: L.createStepEngine({ req, drc, scorer, layout: host, fill: hostFill(ctx, host), fallbackRouter: router }),
        signal: ctx.signal,
        ...(onLine ? { onLine } : {}),
      };
    },
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
    const { ws, deps, host } = await openBench(ctx, wsPath, req);
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
          const nets = a.nets?.length ? a.nets : bench.openNets(sc);
          if (!nets.length) return ok("no open nets; name nets to inspect");
          // KRT's net_forensics names what walls each stuck end; without KRT, the board model's reading
          const stem = bench.state.pcb.replace(/\.kicad_pcb$/, "");
          const rb = await L.routerBoard(bench.board, join(bench.ws, "why"), stem);
          const krt = await L.krtForensics(host, rb, nets);
          const out = krt ?? L.whyLines(L.whyOpen(parseBoard(await readFile(bench.board, "utf8")), sc.opens, nets)).slice(0, -1);
          if (!krt) out.unshift("(KiCadRoutingTools not configured: walls from the board model, not KRT's net_forensics)");
          if (!a.nets?.length) {
            await layout.engineReady(host, "tracemaker"); // installs it on first use unless automatic installs are off
            const causes = await L.tmCauses(host, rb);
            out.push(...(causes ? ["TraceMaker causes:", ...causes.map((l) => "  " + l)] : ["(TraceMaker not available: no cause classes)"]));
          }
          out.push("hint: walls within about 1 mm of a stuck end -> blockers:1.0 or leg; a pad caged by parts or a keepout -> nudge:REF@X,Y");
          return ok(out.join("\n"));
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
        case "fit": {
          const steps = a.actions?.length === 1 ? L.stepsFor(a.actions[0]!) : [];
          const st = steps[0];
          if (steps.length !== 1 || st?.type !== "nudge" || !st.moves) throw new ToolError("fit takes one nudge:/turn: action in actions, e.g. ['nudge:U3@41.2,18@90']", "invalid_args");
          const fixed = await L.fixedParts(req, bench.board);
          const r = await L.fitStep({
            cur: bench.dir,
            out: join(bench.ws, "fit"),
            pcb: bench.state.pcb,
            moves: st.moves,
            req,
            courtyardDrc: host.courtyardDrc,
            fixed: (ref) => fixed.has(ref),
            ...(a.side !== "both" ? { side: a.side } : {}),
            ...(a.box ? { box: a.box } : {}),
            render: async (svg) => (await ctx.services.kicad.rasterizeSvg(svg, { maxWidth: 1400 })).png,
          });
          return ok(r.lines.join("\n"), r as unknown as Record<string, unknown>);
        }
        case "sweep": {
          if (!a.refs) throw new ToolError("sweep needs refs: the parts to sweep, comma separated", "invalid_args");
          const acts = L.sweepActions(await readFile(bench.board, "utf8"), a.refs.split(","), { ...(a.span ? { span: a.span } : {}), ...(a.step ? { step: a.step } : {}), rotations: a.rotations, ...(a.then ? { then: a.then } : {}) });
          log(`sweep: ${acts.length} candidates`);
          const r = await bench.try(acts, { noAccept: a.noAccept, slackA8: 0, jobs: a.jobs ?? 6, budget: a.budget ?? 900 });
          return ok([...lines, ...r.lines].join("\n"), { accepted: r.accepted, step: r.pointer, figures: r.figures, candidates: r.candidates.length });
        }
        case "validate": {
          const rec = await bench.validate();
          const v = join(bench.ws, "validate");
          await layout.engineReady(host, "tracemaker");
          const audit = await L.tmPairAudit(host, await L.routerBoard(join(v, bench.state.pcb), join(v, "tm"), bench.state.pcb.replace(/\.kicad_pcb$/, "")), v);
          const full = { ...rec, ...(audit ? { return_path_warnings: audit.returnPathWarnings, tm_pairs: join(v, "tm-pairs.json") } : { tracemaker: "not installed: no pair or return-path audit" }) };
          await writeFile(join(v, "validate.json"), JSON.stringify(full, null, 1) + "\n");
          return ok(JSON.stringify(full, null, 1), full);
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
  span?: number | undefined;
  step?: number | undefined;
  rotations: "keep" | "flip" | "all";
  then?: string | undefined;
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

/** `board_edit`'s repair hook: the last-mile bench's `finish` step on the edit candidate (the route stage's job). */
export async function repairEditCandidate(
  ctx: ToolContext,
  input: { candidateDir: string; pcb: string; routeAgain: string[] },
  router = "fab_router",
): Promise<{ note: string }> {
  const req = await requirementsFor(ctx);
  const { deps } = await openBench(ctx, join(input.candidateDir, ".lastmile"), req);
  return L.repairCandidate(deps(router, (l) => ctx.progress(0.6, l)), input);
}
