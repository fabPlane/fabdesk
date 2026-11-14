/**
 * The last-mile step engine (toolkit tools/lastmile.py `run_step`): runs one Step of an action from a board folder.
 *
 *   krt     the step's KiCadRoutingTools plan (route_krt), new copper merged onto the native board
 *   repair  rip selected copper (rip_items), then the step's KRT plan routes what the rip opened
 *   nudge   re-seat parts (nudge_place, courtyard-gated), then the step's KRT plan re-routes the cut connections
 *   replace rip the floorplan groups' regions, re-place the groups there (route_region --replace), then the step's KRT
 *           plan routes the opens
 *   pairfix pair width / tighten / vias / mirror / retune / skew in place (no router)
 *   fill    another router fills the opens, everything else fixed (the host's routers)
 *   escape / planes / pour   power copper without a router (lastmile/power.ts): escapes, a split inner plane, pours
 *   cut     route_region's rip (every track/arc/via with a point in the boxes, all nets, then dangling copper), no router;
 *           rip.json names the cut nets, so a later `after-cut` plan (`route`, `region:`) routes cut pairs as pairs.
 *           `region:BOX!escape` = cut, escape, after-cut: route_region --escape's order (escapes on the ripped board)
 *
 * KiCadRoutingTools is an engine the host may not have. Without it only `finish` still runs, on the host's router (it
 * means "route the opens; nothing is ripped", which any router can do); every other KRT step fails by name, so a step
 * never silently becomes a different one.
 */
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseBoard } from "../board";
import type { Requirements } from "../requirements";
import { engineReady, type LayoutHost } from "../layout/ctx";
import type { KrtPlan } from "../layout/plan";
import { routeKrt } from "../layout/route";
import { addNewCopper, changedCopperNets, convertTransforms, keepCopperOfNets, nameCopperNets, numericNetCopper, replaceCopper } from "../layout/text";
import { FILL_ROUTERS, type Step } from "./actions";
import { copyBoardFolder, type Scorer, type StepEngine, type StepInput, type StepOutcome } from "./bench";
import { opensOf, type DrcFn, type DrcRun } from "./scoring";
import { runTighten } from "./tighten";
import { ripStep } from "./rip";
import { nudgeStep } from "./nudge";
import { powerStep } from "./power";
import { regionRip, replaceGroups } from "./replace";
import { readFloorplan, type Blocks } from "../layout/floorplan";
import { fixedRegex } from "../layout/spec";

/** Fill the opens of `dir/board.kicad_pcb` in place with `router` (the host's routers); the board file name is fixed. */
export type FillFn = (router: string, dir: string, o: { signal: AbortSignal; timeoutMs: number }) => Promise<{ message?: string }>;

export interface StepEngineHost {
  req: Requirements;
  /** Native DRC for the pair steps (refilled zones, project severity). */
  drc: DrcFn;
  /** Scores a board folder; a repair reads what its start board fails (`.lastmile/drc-run.json`, `.lastmile/acceptance.json`). */
  scorer: Scorer;
  /** KiCadRoutingTools and process running; `tools.krt` null when KRT is not configured. */
  layout: LayoutHost;
  /** The host's routers for `fill` steps and for `finish` when KRT is missing (fab_router, freerouting, tracemaker). */
  fill: FillFn;
  /** Router for `finish` when KRT is missing. */
  fallbackRouter: string;
  /** Per-router-run time limit, ms (a step's own budget still applies through its signal). */
  routerTimeoutMs?: number;
  /**
   * The folder `plan:FILE` resolves against (the project: board_route paths are project-relative). A plan outside it
   * is refused; without it `plan:FILE` fails by name.
   */
  planRoot?: string;
}

const exists = (p: string) => stat(p).then(() => true, () => false);
/** Where `replace:` finds the floorplan and blocks unless the action names a floorplan (project-relative). */
export const DEFAULT_FLOORPLAN = ".fabdesk/board/layout/floorplan.json";
export const DEFAULT_BLOCKS = ".fabdesk/board/layout/blocks.json";
const stemOf = (pcb: string) => basename(pcb).replace(/\.kicad_pcb$/, "");

/** The plan a step was built from, for messages ("finish", "pairs-todo", "plan:FILE" ...). */
const planName = (step: Step) => (step.planFile ? `plan:${step.planFile}` : (step.planName ?? "krt"));
// a finish with fences or kept-out layers is not one the host router can stand in for (it would ignore them)
const isFinish = (step: Step) => step.type === "krt" && step.planName === "finish" && !step.plan?.["fences"] && !step.avoidLayers?.length;

/** Parts a nudge may not move: the board's mechanical anchors and every locked footprint. */
export async function fixedParts(req: Requirements, boardFile: string): Promise<Set<string>> {
  const out = new Set(req.mechanical.anchors.map((a) => a.reference));
  for (const [ref, fp] of parseBoard(await readFile(boardFile, "utf8")).footprints) if (fp.locked) out.add(ref);
  return out;
}

/** Make sure a board folder has the scorer's records (a chain's intermediate boards are not scored by the bench). */
async function ensureScored(h: StepEngineHost, dir: string, pcb: string, signal: AbortSignal): Promise<void> {
  if ((await exists(join(dir, ".lastmile", "drc-run.json"))) && (await exists(join(dir, ".lastmile", "acceptance.json")))) return;
  await h.scorer.score(dir, pcb, { parity: false, signal });
}

/**
 * Route `src` (a board folder) with a KRT plan into the board folder `out`: `out` is a copy of `src` whose board carries
 * the routed copper (KRT's copper replaces the native copper when the plan says `merge: replace`, else only new copper
 * is added). KRT's working files stay under `out/.lastmile/krt` (skipped when a folder is copied).
 */
/** Nets with an open connection on a scored board folder (its `.lastmile/drc-run.json`). */
async function openNetsOf(dir: string): Promise<Set<string>> {
  const run = JSON.parse(await readFile(join(dir, ".lastmile", "drc-run.json"), "utf8")) as DrcRun;
  return new Set(opensOf(run.unconnected).map((o) => o.net));
}

async function krtRoute(h: StepEngineHost, src: string, out: string, pcb: string, plan: KrtPlan, signal: AbortSignal, onlyNets?: Set<string>, avoidLayers?: readonly string[]): Promise<Record<string, unknown>> {
  await copyBoardFolder(src, out);
  const work = join(out, ".lastmile", "krt");
  await rm(work, { recursive: true, force: true });
  await mkdir(join(out, ".lastmile"), { recursive: true });
  const host: LayoutHost = { ...h.layout, signal };
  const admission = host.admit ? await host.admit("router", "lastmile krt", [src], { engine: "krt" }) : { release() {} };
  let record;
  try {
    record = await routeKrt(host, { placed: src, out: work, plan, stem: stemOf(pcb), req: h.req, score: false, ...(avoidLayers?.length ? { avoidLayers } : {}) });
  } finally {
    admission.release();
  }
  if (record.error) throw new Error(`KRT: ${record.error}`);
  const native = await readFile(join(src, pcb), "utf8");
  const routed = nameCopperNets(await readFile(join(work, "routed-native-names.kicad_pcb"), "utf8")).text;
  const source = () => nameCopperNets(convertTransforms(native).text).text;
  let restricted: Record<string, unknown> | null = null;
  let merged;
  if (onlyNets) {
    const src0 = source();
    const others = changedCopperNets(src0, routed).filter((n) => !onlyNets.has(n));
    merged = addNewCopper(native, src0, keepCopperOfNets(routed, onlyNets));
    restricted = { only_open_nets: onlyNets.size, other_nets_router_touched_not_kept: others.length, ...(others.length ? { other_nets_sample: others.slice(0, 8) } : {}) };
  } else merged = plan.merge === "replace" ? replaceCopper(native, routed) : addNewCopper(native, source(), routed);
  const numeric = numericNetCopper(merged.text);
  if (numeric) throw new Error(`${numeric} copper items name their net by number after the merge`);
  await writeFile(join(out, pcb), merged.text);
  const stages = record.stages.map((s) => ({ name: s["name"], ...(s["skipped"] ? { skipped: s["skipped"] } : { exit: s["exit"], wall_s: s["wall_s"] }) }));
  return { engine: "krt", wall_s: record.wall_s, stages, merge: merged.stats, ...(restricted ? { restricted } : {}), ...(record.avoided ? { avoided: record.avoided } : {}) };
}

/**
 * Run a host router on a board folder whose board may have any name: the host's routers work on `board.kicad_pcb`, so
 * the board and its project files are routed in a scratch folder under that name and the result is copied back.
 */
async function fillRoute(h: StepEngineHost, router: string, src: string, out: string, pcb: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  await copyBoardFolder(src, out);
  const stem = stemOf(pcb);
  // a whole project copy (the host may read more than the board), under .lastmile so router output is never copied on
  const scratch = join(out, ".lastmile", "fill");
  await rm(scratch, { recursive: true, force: true });
  await copyBoardFolder(src, scratch);
  if (stem !== "board") {
    await copyFile(join(src, pcb), join(scratch, "board.kicad_pcb"));
    for (const ext of ["kicad_pro", "kicad_dru"]) if (await exists(join(src, `${stem}.${ext}`))) await copyFile(join(src, `${stem}.${ext}`), join(scratch, `board.${ext}`));
  }
  const cls = router === "tracemaker" ? "tracemaker" : "router";
  // a router not named here is admitted on the grid estimate (the conservative default)
  const engine = router === "tracemaker" || router === "freerouting" || router === "fab_router" ? router : undefined;
  const admission = h.layout.admit ? await h.layout.admit(cls, `lastmile fill ${router}`, [src], engine ? { engine } : {}) : { release() {} };
  let s;
  try {
    s = await h.fill(router, scratch, { signal, timeoutMs: h.routerTimeoutMs ?? 600_000 });
  } finally {
    admission.release();
  }
  await copyFile(join(scratch, "board.kicad_pcb"), join(out, pcb));
  await rm(scratch, { recursive: true, force: true });
  return { engine: router, ...(s.message ? { message: s.message } : {}) };
}

/** `plan:FILE` resolved inside `root` (symlinks followed); refused by name when missing or outside it. */
export async function resolvePlanFile(root: string | undefined, file: string): Promise<string> {
  const what = `plan:${file}`;
  if (!root) throw new Error(`${what}: no project folder to resolve the plan file against`);
  const top = await realpath(root);
  const real = await realpath(resolve(top, file)).catch(() => null);
  if (!real) throw new Error(`${what}: no such file in the project (paths are project-relative)`);
  const rel = relative(top, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${what}: outside the project`);
  return real;
}

async function stepPlan(h: StepEngineHost, step: Step): Promise<KrtPlan> {
  if (step.planFile) {
    const file = await resolvePlanFile(h.planRoot, step.planFile);
    try {
      return JSON.parse(await readFile(file, "utf8")) as KrtPlan;
    } catch (e) {
      throw new Error(`plan:${step.planFile}: not a JSON router plan (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (!step.plan) throw new Error(`${step.type} step has no router plan`);
  return step.plan as unknown as KrtPlan;
}

/**
 * Kept short: the bench shows the last 160 characters of a step error (the step's name leads it, so the message must
 * leave room for it: `replace (re-routing the region)` was cut when the power steps joined the list). With `why` (the host tried to install KRT and
 * could not) its tail is kept, where the install's own advice is.
 */
export const needsKrt = (what: string, why?: string) =>
  why
    ? `${what}: KRT did not install (${why.length > 100 ? `…${why.slice(-100)}` : why})`
    : `${what} needs KiCadRoutingTools (board_engines install krt); without it: finish, fill:ROUTER, tighten, escape, planes, pour, cut`;

export function createStepEngine(h: StepEngineHost): StepEngine {
  /** KRT's root, installed on first use when the host can; `why` says what stopped that. */
  const krt = () => engineReady(h.layout, "krt");
  return {
    async run(step: Step, input: StepInput): Promise<StepOutcome> {
      const { cur, out, pcb, signal } = input;
      signal.throwIfAborted(); // between the steps of a chain and inside a step, nothing starts once the budget is spent
      switch (step.type) {
        case "pairfix":
          return runTighten({ step, input, req: h.req, drc: h.drc });
        case "escape":
        case "planes":
        case "pour":
          return powerStep(step, input, { req: h.req, planFile: (f) => resolvePlanFile(h.planRoot, f).catch((e: Error) => Promise.reject(new Error(e.message.replace(/^plan:/, "planes:")))), scored: () => ensureScored(h, cur, pcb, signal) });
        case "cut": {
          if (!step.cut || (!step.cut.boxes.length && step.cut.aroundOpens === undefined)) return { error: "cut needs a box: cut:X0,Y0,X1,Y1 or cut:opens~MM" };
          const regions = [...step.cut.boxes] as Array<[number, number, number, number]>;
          const m = step.cut.aroundOpens;
          if (m !== undefined) {
            // route_region --around-opens: a box round each end of every open connection (the stuck pins, not the span)
            await ensureScored(h, cur, pcb, signal);
            const run = JSON.parse(await readFile(join(cur, ".lastmile", "drc-run.json"), "utf8")) as DrcRun;
            for (const u of run.unconnected) for (const i of u.items) regions.push([(i.pos?.x ?? 0) - m, (i.pos?.y ?? 0) - m, (i.pos?.x ?? 0) + m, (i.pos?.y ?? 0) + m]);
            if (!regions.length) return { dir: cur, skipped: true, info: { engine: "cut", note: "no open connections to cut round" } };
          }
          const text = await readFile(join(cur, pcb), "utf8");
          const r = regionRip(text, regions);
          const info = { engine: "cut", boxes: regions, removed: r.removed, nets: r.nets.length };
          if (r.text === text) return { dir: cur, skipped: true, info };
          await copyBoardFolder(cur, out);
          await writeFile(join(out, pcb), r.text);
          // rip.json as rip_items writes it: `nets` feeds @cut-pairs of a later after-cut plan
          const n = r.removed.segment + r.removed.via + r.removed.arc;
          await writeFile(join(out, "rip.json"), JSON.stringify({ src: cur, removed: n, pruned: r.removed.pruned, nets: r.nets, windows: regions, open_before: [] }, null, 1) + "\n");
          return { dir: out, info };
        }
        case "fill": {
          if (!step.router) return { error: `fill needs a router: ${FILL_ROUTERS.map((r) => `fill:${r}`).join(", ")}` };
          return { dir: out, info: await fillRoute(h, step.router, cur, out, pcb, signal) };
        }
        case "krt": {
          const k = await krt();
          if (!k.path) {
            if (isFinish(step)) return { dir: out, info: { ...(await fillRoute(h, h.fallbackRouter, cur, out, pcb, signal)), fallback: `KiCadRoutingTools ${k.why ? `did not install (${k.why})` : "not configured"}: finish ran on ${h.fallbackRouter}` } };
            return { error: needsKrt(planName(step), k.why) };
          }
          const plan = await stepPlan(h, step);
          // @pairs-todo reads what the start board fails
          await ensureScored(h, cur, pcb, signal);
          signal.throwIfAborted();
          // finish means "route the opens; nothing is ripped": only new copper on the nets that were open is kept, so the
          // rest of the board stays exactly as it was (KRT also adds pad-entry stubs on other nets, which a reroute must not)
          const onlyNets = step.planName === "finish" ? await openNetsOf(cur) : undefined;
          return { dir: out, info: await krtRoute(h, cur, out, pcb, plan, signal, onlyNets, step.avoidLayers) };
        }
        case "repair": {
          const k = await krt();
          if (!k.path) return { error: needsKrt(`${planName(step)} after its rip`, k.why) };
          const plan = await stepPlan(h, step);
          await ensureScored(h, cur, pcb, signal);
          const args = (step.rip ?? []).map((x) => x.replace("{start}", input.start));
          if (args.includes("--spare-open-nets")) await ensureScored(h, input.start, pcb, signal);
          signal.throwIfAborted();
          const ripped = join(out, "ripped");
          const rip = await ripStep({ cur, out: ripped, pcb, args, req: h.req });
          if (!rip.removed) return { dir: cur, skipped: true, info: { rip } }; // nothing to repair: the board is unchanged
          signal.throwIfAborted();
          const routed = join(out, "route");
          return { dir: routed, info: { rip, ...(await krtRoute(h, ripped, routed, pcb, plan, signal, undefined, step.avoidLayers)) } };
        }
        case "nudge": {
          const k = await krt();
          if (!k.path) return { error: needsKrt("nudge (re-routing what it cuts)", k.why) };
          if (!step.moves) return { error: "nudge step has no moves" };
          const plan = await stepPlan(h, step);
          const nudged = join(out, "nudged");
          const fixed = await fixedParts(h.req, join(cur, pcb));
          const nudge = await nudgeStep({ cur, out: nudged, pcb, moves: step.moves, req: h.req, courtyardDrc: h.layout.courtyardDrc, fixed: (r) => fixed.has(r) });
          signal.throwIfAborted();
          const routed = join(out, "route");
          return { dir: routed, info: { nudge, ...(await krtRoute(h, nudged, routed, pcb, plan, signal, undefined, step.avoidLayers)) } };
        }
        case "replace": {
          const k = await krt();
          if (!k.path) return { error: needsKrt("replace (re-routing the region)", k.why) };
          if (!step.replace) return { error: "replace step has no groups" };
          const plan = await stepPlan(h, step);
          const fpRel = step.replace.floorplan ?? DEFAULT_FLOORPLAN;
          const fpFile = await resolvePlanFile(h.planRoot, fpRel).catch((e: Error) => Promise.reject(new Error(e.message.replace(`plan:${fpRel}`, `replace floorplan ${fpRel}`))));
          const blocksFile = (await exists(join(fpFile, "..", "blocks.json"))) ? join(fpFile, "..", "blocks.json") : await resolvePlanFile(h.planRoot, DEFAULT_BLOCKS).catch(() => null);
          if (!blocksFile) return { error: `replace: no blocks.json beside ${fpRel} (board_route blocks writes ${DEFAULT_BLOCKS})` };
          const blocks = JSON.parse(await readFile(blocksFile, "utf8")) as Blocks;
          const floorplan = readFloorplan(JSON.parse(await readFile(fpFile, "utf8")), blocks);
          const fixed = await fixedParts(h.req, join(cur, pcb));
          const replaced = join(out, "replaced");
          const admission = h.layout.admit ? await h.layout.admit("tracemaker", "lastmile replace", [cur]) : { release() {} };
          let rec;
          try {
            rec = await replaceGroups({ ...h.layout, signal }, { cur, out: replaced, pcb, floorplan, blocks, groups: step.replace.groups, fixed: new RegExp(fixed.size ? fixedRegex([...fixed]) : "^$"), ...(step.replace.seed !== undefined ? { seed: step.replace.seed } : {}) });
          } finally {
            admission.release();
          }
          const summary = { groups: rec.groups, removed: rec.removed, passes: rec.placement.groups.map((g) => ({ group: g.group, parts: g.parts, placed: g.placed, ok: g.ok })), native_courtyard: rec.placement.native_courtyard };
          if (!rec.placement.ok) return { error: `replace: block placement failed: ${rec.placement.groups.filter((g) => !g.ok).map((g) => `${g.group} placed ${g.placed} of ${g.parts}`).join("; ")}` };
          if (Object.keys(rec.placement.native_courtyard ?? {}).length) return { error: `replace: native courtyard check failed ${JSON.stringify(rec.placement.native_courtyard)}` };
          signal.throwIfAborted();
          const routed = join(out, "route");
          return { dir: routed, info: { replace: summary, ...(await krtRoute(h, replaced, routed, pcb, plan, signal, undefined, step.avoidLayers)) } };
        }
        default:
          return { error: `unknown step type ${(step as Step).type}` };
      }
    },
  };
}
