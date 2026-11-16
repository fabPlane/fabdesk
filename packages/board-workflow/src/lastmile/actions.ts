/**
 * The last-mile action vocabulary (toolkit tools/bench.py ACTIONS and steps_for): an action string such as
 * `blockers:1.0`, `taps+a7` or `reroute:^(USB_D)$+shorts+tighten` becomes a chain of steps. Steps are data; engines run
 * them (`pairfix` in this package, router steps through a StepEngine that wraps what the host has installed).
 */
import { LASTMILE_PLANS } from "./plans";
import { pairStages, SHORT_LEG_RULE, type PairStageOptions } from "../layout/krt-override";
import type { PlanStage } from "../layout/plan";

export type StepType = "krt" | "repair" | "nudge" | "fill" | "pairfix" | "escape" | "planes" | "pour" | "replace" | "cut";

export interface Step {
  type: StepType;
  /** Router plan (a copy of the toolkit's template, edited by the action), for `krt`, `repair` and `nudge` steps. */
  plan?: Record<string, unknown>;
  /** A plan file named by the caller (`plan:FILE`). */
  planFile?: string;
  /** The template `plan` was copied from (`finish`, `pairs-todo`, `after-cut` ...), for messages and engine choice. */
  planName?: string;
  /** `repair`: arguments of the rip selection (`--around-opens 1.0 --spare-pairs`). */
  rip?: string[];
  /** `nudge`: the pose moves and the gates (clearance, edge). */
  moves?: { clearance: number; edge: number; moves: NudgeMove[] };
  /** `fill`: which router fills the opens. */
  router?: string;
  /** `pairfix`: arguments (`--pairs REGEX`, `--ops mirror-force`). */
  args?: string[];
  /** `escape`: how far a stub reaches beyond the pad edge and the clearance it keeps, mm. */
  escape?: { maxStub: number; clearance: number };
  /** `pour`: more nets as shell globs, the margin round an open's ends and the min_thickness scale (`planes` uses `planFile`). */
  pour?: { nets: string[]; margin: number; minWidthScale: number };
  /** `replace`: floorplan groups to rip and re-place (route_region --replace), the floorplan file, the placer seed. */
  replace?: { groups: string[]; floorplan?: string; seed?: number };
  /**
   * `cut`: boxes X0,Y0,X1,Y1 whose copper is ripped, all nets (route_region's rip), no router; `aroundOpens` adds a box
   * of +-that many mm round each end of every open connection of the board the step starts from (`--around-opens`).
   */
  cut?: { boxes: number[][]; aroundOpens?: number };
  /**
   * Layers the step's KRT plan keeps out of reach, applied after its macros expand (`layout/plan.ts` avoidLayerArgs:
   * an inner layer left out of `--layers`, an outer one at `--layer-costs` 10). Set by the bench's `~avoid` retry of a
   * candidate that split another net's pour; honoured by every step that runs a KRT plan.
   */
  avoidLayers?: string[];
  /**
   * Options for the pair stages (`route_diff`) of the step's KRT plan, from the action's `!short` / `!match[=MM]`
   * modifiers (routeKrt `pairOptions`): couple the short fan-out legs too (KRT's short-leg rule lowered through the
   * override wrapper, layout/krt-override.ts), P/N length matching inside each pair.
   */
  pairOptions?: PairStageOptions;
}

/** Steps that run a KRT plan (and so can honour `avoidLayers`). */
export const runsKrtPlan = (s: Step) => (s.type === "krt" || s.type === "repair" || s.type === "nudge" || s.type === "replace") && !!(s.plan || s.planFile);

export interface NudgeMove {
  ref: string;
  radius: number;
  /** A point, or a part / pad to sit next to (`REF`, `REF.PAD`). */
  near?: [number, number] | string;
  rotations?: number[];
}

export const SHORTS = "shorting_items,tracks_crossing,clearance";

const plan = (n: string): Record<string, unknown> => {
  const p = LASTMILE_PLANS[n];
  if (!p) throw new Error(`no plan template ${n}`);
  return structuredClone(p);
};
const K = (n: string): Step => ({ type: "krt", plan: plan(n), planName: n });
/**
 * `finish` limited to the nets open on the board it starts from (KRT `--nets @open-before`; with no rip before it, the
 * bench's score of that board names them). Not a toolkit plan: on held-out 12-layer boards `finish` (every unrouted
 * connection) ran past 6 minutes, and agents wrote this restriction by hand and had their nets in 1-2 minutes.
 */
const finishOpens = (): Step => {
  const f = structuredClone(plan("finish")) as { note?: string; stages: Array<{ args: string[] }> };
  f.note = "fabdesk: finish limited to the nets open on the start board (--nets @open-before)";
  f.stages[0]!.args = [...f.stages[0]!.args, "--nets", "@open-before"];
  return { type: "krt", plan: f as Record<string, unknown>, planName: "finish-opens" };
};
const REP = (rip: string[], p = "rip-sig"): Step => ({ type: "repair", rip, plan: plan(p), planName: p });

/** The host routers a `fill` step can name (the tools package's hostFill runs exactly these). */
export const FILL_ROUTERS = ["tracemaker", "freerouting", "fab_router"] as const;

type Builder = (arg: string) => Step[];
export const ACTIONS: Record<string, { help: string; steps: Builder | null }> = {
  finish: { help: "route the opens; nothing is ripped", steps: () => [K("finish")] },
  opens: { help: "route only the nets open now (finish limited to them, nothing ripped): on a large board much faster than finish", steps: () => [finishOpens()] },
  rip: { help: "route the opens; signal nets may be ripped whole (pairs and wide power protected)", steps: () => [K("rip-sig")] },
  leg: {
    help: "leg-level rip with near-target blocker selection, then repair its shorts keeping the new routes",
    steps: () => [K("rip-sig-leg-nt"), REP(["--drc", SHORTS, "--spare-open-nets", "{start}"])],
  },
  blockers: { help: "blockers:R  cut all copper within R mm of each open end, route the opens first, then the cut", steps: (a) => [REP(["--around-opens", a || "1.0", "--spare-pairs"], "opens-first")] },
  window: { help: "window:X0,Y0,X1,Y1  cut the copper in a box (pairs spared), route opens first, then the cut", steps: (a) => [REP(["--window", ...boxArgs(`window:${a}`, a), "--spare-pairs"], "opens-first")] },
  taps: { help: "tap pass: remaining connections of power nets with tap pads at tap width (acceptance tap_rule)", steps: () => [K("taps")] },
  a7: { help: "cut power copper that fails A7 and route it again", steps: () => [REP(["--a7"])] },
  shorts: { help: "cut copper named in shorts/crossings/clearance errors (pairs kept) and route it again", steps: () => [REP(["--drc", SHORTS, "--spare-pairs"])] },
  tighten: {
    help:
      "tighten[:REGEX]  pairs to class width and spacing in place, no router (one-sided length wiggles made compact, P/N moved together, 45 degree jogs at pads/vias; native DRC judges every round, refused groups reverted)",
    steps: (a) => [{ type: "pairfix", args: a ? ["--pairs", a] : [] }],
  },
  reroute: {
    help:
      "reroute[:REGEX]  local pair re-route: cut only the uncoupled stretches of failing pairs (their vias too), keep coupled runs and pad stubs, route them again as pairs between the stubs under the board's pair rules; reroute:REGEX! also cuts uncoupled pad stubs",
    steps: (a) => [REP(["--a8-uncoupled", a.replace(/!+$/, ""), ...(a.endsWith("!") ? ["--rip-pad-stubs"] : [])], "pairs-reroute")],
  },
  mirror: {
    help:
      "mirror[:REGEX]  make room for a coupled path: one member of each failing pair rebuilt along the other's path even over ordinary signal tracks, then those tracks cut and routed again round it (pairs protected), then tighten",
    steps: (a) => [
      { type: "pairfix", args: ["--ops", "mirror-force", ...(a ? ["--pairs", a] : [])] },
      REP(["--drc", SHORTS, "--spare-pairs"]),
      { type: "pairfix", args: a ? ["--pairs", a] : [] },
    ],
  },
  "pairs-fix": { help: "pairs-fix[:REGEX]  the pair pipeline: tighten (in place), reroute what still fails, shorts, tighten again (length matched last)", steps: null },
  pairs: { help: "route again, as pairs, the pairs failing A8 or over the length-difference limit", steps: () => [K("pairs-todo")] },
  bundle: {
    help: "bundle:REGEX[@X0,Y0,X1,Y1]  rip every pair whose name matches and route them again together as pairs; with a box, first cut the other copper in it (pairs spared) and route it back after the bundle",
    steps: null,
  },
  fence: { help: "fence:X0,Y0,X1,Y1=NETREGEX  reserved corridor for the rest of the chain: matching nets may not route inside the box (router copy only)", steps: null },
  "pairs-m": { help: "as pairs, with P/N length matching, then repair what the meanders collide with", steps: () => [K("pairs-todo-m"), REP(["--drc", SHORTS, "--spare-pairs"])] },
  "pairs-all": { help: "rip and route every pair again as a pair (first pair pass on a board routed single-ended)", steps: () => [K("pairs-g2")] },
  legs: { help: "legs:R  short pair legs failing A8: cut them and the copper within R mm of their pads, route them first", steps: (a) => [REP(["--a8", "short", "--around-ripped", a || "1.0", "--spare-pairs"], "opens-first")] },
  fill: { help: `fill:${FILL_ROUTERS.join("|")}  another router fills the opens, everything else fixed`, steps: (a) => [{ type: "fill", router: a }] },
  nudge: { help: "nudge:REF@X,Y[@ROT[/ROT..]][~RADIUS][&REF2@..]  re-seat parts near points (pose computed, courtyard-gated), cut pairs re-routed as pairs", steps: null },
  turn: { help: "turn:REF@ROT[/ROT..][~RADIUS]  re-seat a part where it is at another rotation (see `crossings`)", steps: null },
  plan: { help: "plan:FILE  any router plan", steps: (a) => [{ type: "krt", planFile: a }] },
  escape: {
    help:
      "escape[:STUB[,CLEARANCE]]  fine-pitch power escapes, no router: pad-width bridges between adjacent same-net pins and pad-width stubs out from power pins narrower than their class (STUB mm beyond the pad, default 0.9, never past 1.0 mm from its centre: the neck rule), each clear of other-net copper by CLEARANCE (default 0.1); chain a router after it, e.g. escape+finish",
    steps: (a) => {
      const [s, c, ...more] = a ? a.split(",") : [];
      if (more.length) throw new ActionError(`escape:${a}: escape[:STUB[,CLEARANCE]]`);
      return [{ type: "escape", escape: { maxStub: s ? num(`escape:${a}`, s) : 0.9, clearance: c ? num(`escape:${a}`, c) : 0.1 } }];
    },
  },
  planes: {
    help:
      "planes:FILE  split power plane on an inner layer from a plan JSON in the project (layer, nets with weights, reach_mm, fill_net, keepout_circles ...): grid cells go to the nearest plan net's pads, pieces joined by corridors, the fill net elsewhere; zones only, no router",
    steps: (a) => {
      if (!a) throw new ActionError("planes:FILE  a power-planes plan JSON, project-relative");
      return [{ type: "planes", planFile: a }];
    },
  },
  pour: {
    help:
      "pour[:GLOB,..][~MARGIN][@SCALE]  net zones over the open connections of power nets (and nets matching a shell GLOB; '+' chains actions, so write ?5V for +5V) on the outer layer both ends share, MARGIN mm round the ends (default 1.5); KiCad's fill keeps clearances and never goes thinner than class width x SCALE (default 1.0), so a pour only connects where the current fits",
    steps: (a) => {
      const m = /^([^~@]*)(?:~([^~@]+))?(?:@([^~@]+))?$/.exec(a);
      if (!m) throw new ActionError(`pour:${a}: pour[:GLOB,..][~MARGIN][@SCALE]`);
      const what = `pour:${a}`;
      return [{ type: "pour", pour: { nets: m[1] ? m[1].split(",").filter(Boolean) : [], margin: m[2] ? num(what, m[2]) : 1.5, minWidthScale: m[3] ? num(what, m[3]) : 1.0 } }];
    },
  },
  cut: {
    help:
      "cut:X0,Y0,X1,Y1[;X0,Y0,X1,Y1..|;opens~MM]  rip every track, arc and via with a point in the boxes (all nets, pairs too) and the copper left dangling, no router (route_region's rip); opens~MM adds a box of +-MM round each end of every open connection; chain what comes next, e.g. cut:opens~1.5+escape+route (= region:opens~1.5!escape)",
    steps: (a) => [{ type: "cut", cut: boxes(`cut:${a}`, a) }],
  },
  region: {
    help:
      "region:X0,Y0,X1,Y1[;..|;opens~MM][!escape]  route_region: cut the boxes (all nets; opens~MM = --around-opens MM), with !escape add the fine-pitch power escapes on the ripped board (escape), then route the opens: cut pairs again as pairs, their legs, then the rest (after-cut)",
    steps: (a) => {
      const esc = a.endsWith("!escape");
      const spec = esc ? a.slice(0, -"!escape".length) : a;
      return [{ type: "cut", cut: boxes(`region:${a}`, spec) }, ...(esc ? [{ type: "escape" as const, escape: { maxStub: 0.9, clearance: 0.1 } }] : []), K("after-cut")];
    },
  },
  route: { help: "route the opens after a cut: cut pairs again as pairs, their single-ended legs, then everything else (the after-cut plan)", steps: () => [K("after-cut")] },
  replace: {
    help:
      "replace:GROUP[,GROUP..][@FLOORPLAN][#SEED]  the per-block loop: rip every track and via in the floorplan groups' regions (all nets), re-place the groups inside their regions with everything else locked (TraceMaker placer, courtyard-gated), then route the opens; FLOORPLAN defaults to .fabdesk/board/layout/floorplan.json (blocks.json beside it)",
    steps: (a) => {
      const m = /^([^@#]+)(?:@([^#]+))?(?:#(\d+))?$/.exec(a);
      if (!m) throw new ActionError("replace:GROUP[,GROUP..][@FLOORPLAN][#SEED]");
      return [{ type: "replace", replace: { groups: m[1]!.split(",").filter(Boolean), ...(m[2] ? { floorplan: m[2] } : {}), ...(m[3] ? { seed: Number(m[3]) } : {}) }, plan: plan("after-cut"), planName: "after-cut" }];
    },
  },
};

export class ActionError extends Error {}

const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
/** A number written in an action, strictly (`1.2.3`, `1e`, `` are refused by name, never passed on as NaN). */
function num(action: string, x: string | undefined): number {
  if (x === undefined || !NUMBER.test(x)) throw new ActionError(`${action}: '${x ?? ""}' is not a number`);
  return Number(x);
}
/** A comma-separated box X0,Y0,X1,Y1 of strict numbers. */
function box(action: string, s: string): number[] {
  const v = s.split(",");
  if (v.length !== 4) throw new ActionError(`${action}: a box is X0,Y0,X1,Y1 (got '${s}')`);
  return v.map((x) => num(action, x));
}
/** One or more boxes separated by ';', and `opens~MM` (a box round each open end). */
function boxes(action: string, s: string): { boxes: number[][]; aroundOpens?: number } {
  if (!s) throw new ActionError(`${action}: give a box X0,Y0,X1,Y1 (several separated by ';') or opens~MM`);
  const out: { boxes: number[][]; aroundOpens?: number } = { boxes: [] };
  for (const b of s.split(";")) {
    const m = /^opens(?:~(.*))?$/.exec(b);
    if (m) out.aroundOpens = m[1] === undefined ? 1.0 : num(action, m[1]);
    else out.boxes.push(box(action, b));
  }
  return out;
}
/** The box's numbers as written, once each is checked. */
const boxArgs = (action: string, s: string): string[] => (box(action, s), s.split(","));

/**
 * Modifiers an action that routes pairs as pairs takes (`pairs!short`, `bundle:REGEX@BOX!short!match!outer=2`): written after
 * the action and its argument, each behind a `!`. They apply to the pair stages (KRT `route_diff`) of the action's
 * router plans and make no sense elsewhere, so an action without such a stage refuses them by name.
 */
export const PAIR_MODIFIERS: Record<string, string> = {
  short: `couple the short fan-out legs too: KiCadRoutingTools routes a pair leg single-ended when it has under max(5 x the centerline setback, 3 mm) of coupled run ("electrically short", every leg of a 0.5 mm pitch connector fan-out); !short lowers that rule to max(${SHORT_LEG_RULE.setbacks} x setback, ${SHORT_LEG_RULE.floorMm} mm) for this action's pair stages (the installed KRT is not edited)`,
  match: "match[=MM]  P/N length matching inside each pair as it is routed (--diff-pair-intra-match --length-match-tolerance MM, default 1.0)",
  outer: "outer=COST  the outer layers (F.Cu, B.Cu) at this layer cost in the pair stages instead of the templates' 20, for pairs whose pads and short legs are on an outer layer (a connector and its ESD parts on F.Cu)",
};
const MATCH = /^match(?:=(.*))?$/;
const OUTER = /^outer=(.*)$/;

/**
 * A part's `!short` / `!match[=MM]` / `!outer=COST` taken off (wherever they sit among its `!` suffixes): the rest of
 * the part as written, the options, and the modifiers as written (`mods`, for actions that hand them on).
 */
export function pairModifiers(part: string): { part: string; options: PairStageOptions | null; mods: string } {
  const toks = part.split("!");
  const keep = [toks[0]!];
  const mods: string[] = [];
  const o: PairStageOptions = {};
  for (const tk of toks.slice(1)) {
    const m = MATCH.exec(tk);
    const c = OUTER.exec(tk);
    if (tk === "short") o.shortLegs = { ...SHORT_LEG_RULE };
    else if (m) {
      o.intraMatch = m[1] === undefined ? 1.0 : num(`${part}: !match`, m[1]);
      if (!(o.intraMatch > 0)) throw new ActionError(`${part}: !match=MM needs a tolerance above 0`);
    } else if (c) {
      o.outerCost = num(`${part}: !outer`, c[1]);
      if (!(o.outerCost >= 1)) throw new ActionError(`${part}: !outer=COST needs a cost of at least 1 (1 = no penalty)`);
    } else {
      keep.push(tk);
      continue;
    }
    mods.push("!" + tk);
  }
  return { part: keep.join("!"), options: mods.length ? o : null, mods: mods.join("") };
}

/** True when the step's router plan has a pair stage (a `plan:FILE` is read only when it runs, so it counts). */
const routesPairs = (s: Step) => runsKrtPlan(s) && (!!s.planFile || pairStages(((s.plan?.["stages"] as PlanStage[] | undefined) ?? [])).length > 0);

const NUDGE = /^([^@]+)@([-\d.]+),([-\d.]+)(?:@([\d./]+))?(?:~([\d.]+))?$/;
const TURN = /^([^@]+)()()@([\d./]+)(?:~([\d.]+))?$/;

/** Action string to steps: `a+b` chains actions; `name:arg` passes an argument. */
export function stepsFor(action: string): Step[] {
  const steps: Step[] = [];
  const fences: Array<{ name: string; box: number[]; nets: string }> = [];
  const parts = action
    .split("+")
    .map((p) => {
      // pairs-fix[:REGEX][!short][!match]: the modifiers go to its re-route, the one step that routes pairs
      const { part: q, mods } = pairModifiers(p);
      if (q.split(":")[0] !== "pairs-fix") return p;
      const r = q.includes(":") ? ":" + q.slice(q.indexOf(":") + 1) : "";
      return `tighten${r}+reroute${r}${mods}+shorts+tighten${r}`;
    })
    .join("+")
    .split("+");
  for (const whole of parts) {
    const { part, options: pairOptions } = pairModifiers(whole);
    const i = part.indexOf(":");
    const name = i < 0 ? part : part.slice(0, i);
    const arg = i < 0 ? "" : part.slice(i + 1);
    const def = ACTIONS[name];
    if (!def) throw new ActionError(`unknown action '${name}'; the actions are:\n${actionHelp().join("\n")}`);
    if (name === "fence") {
      const [bx, , rx] = [arg.slice(0, arg.indexOf("=")), "=", arg.slice(arg.indexOf("=") + 1)];
      fences.push({ name: `fence${fences.length}`, box: box(part, bx), nets: rx });
      continue;
    }
    const first = steps.length;
    if (name === "nudge" || name === "turn") {
      const moves: NudgeMove[] = arg.split("&").map((one) => {
        const m = (name === "nudge" ? NUDGE : TURN).exec(one);
        if (!m) throw new ActionError("nudge:REF@X,Y[@ROT[/ROT]][~RADIUS][&REF2@...]   turn:REF@ROT[/ROT][~RADIUS]");
        const what = `${name}:${one}`;
        return {
          ref: m[1]!,
          radius: m[5] ? num(what, m[5]) : 2.5,
          ...(name === "nudge" ? { near: [num(what, m[2]), num(what, m[3])] as [number, number] } : {}),
          ...(m[4] ? { rotations: m[4].split("/").map((r) => num(what, r)) } : {}),
        };
      });
      steps.push({ type: "nudge", moves: { clearance: 0.2, edge: 0.4, moves }, plan: plan("after-cut"), planName: "after-cut" });
    } else if (name === "bundle") {
      const at = arg.indexOf("@");
      const rx = at < 0 ? arg : arg.slice(0, at);
      const win = at < 0 ? "" : arg.slice(at + 1);
      const p = plan("pairs-todo");
      p["bundle"] = rx;
      p["note"] = `bundle ${rx}: ` + String(p["note"] ?? "");
      for (const st of p["stages"] as Array<{ args: string[] }>) st.args = st.args.map((x) => x.replace("@pairs-todo=", "@bundle="));
      steps.push(win ? { type: "repair", rip: ["--window", ...boxArgs(part, win), "--spare-pairs"], plan: p, planName: `bundle ${rx}` } : { type: "krt", plan: p, planName: `bundle ${rx}` });
    } else {
      if (!def.steps) throw new ActionError(`action '${name}' has no steps`);
      steps.push(...def.steps(arg));
    }
    if (pairOptions) {
      const routing = steps.slice(first).filter(routesPairs);
      if (!routing.length)
        throw new ActionError(`${whole}: !short / !match / !outer apply to actions that route pairs as pairs (pairs, pairs-m, pairs-all, bundle, reroute, route, region, nudge, turn, replace, plan:FILE); '${name}' has no pair stage`);
      for (let k = first; k < steps.length; k++) if (routesPairs(steps[k]!)) steps[k] = { ...steps[k]!, pairOptions: { ...steps[k]!.pairOptions, ...pairOptions } };
    }
    if (fences.length)
      for (let k = first; k < steps.length; k++) {
        const s = steps[k]!;
        if (s.plan) steps[k] = { ...s, plan: { ...s.plan, fences: [...((s.plan["fences"] as unknown[]) ?? []), ...fences] } };
      }
  }
  return steps;
}

export function actionHelp(): string[] {
  return [
    ...Object.entries(ACTIONS).map(([k, v]) => `${k.padEnd(10)} ${v.help}`),
    "chain with '+', e.g. taps+a7",
    "modifiers of an action that routes pairs as pairs, after it and its argument (e.g. bundle:HDMI!short!match!outer=2):",
    ...Object.entries(PAIR_MODIFIERS).map(([k, v]) => `  !${/^\S+\s\s/.test(v) && v.startsWith(k) ? v : `${k.padEnd(8)} ${v}`}`),
  ];
}

/** Last-mile order of a board (WORKFLOW.md section 3); the agent decides what to try, the bench judges. */
export const LASTMILE_ORDER = "rip -> taps -> pairs-all -> leg | blockers:1.0 (try both in parallel) -> a7 -> bundle:REGEX per pair bundle -> pairs -> validate; then crossings, fit, nudge";
