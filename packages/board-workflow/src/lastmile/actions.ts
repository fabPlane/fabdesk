/**
 * The last-mile action vocabulary (toolkit tools/bench.py ACTIONS and steps_for): an action string such as
 * `blockers:1.0`, `taps+a7` or `reroute:^(USB_D)$+shorts+tighten` becomes a chain of steps. Steps are data; engines run
 * them (`pairfix` in this package, router steps through a StepEngine that wraps what the host has installed).
 */
import { LASTMILE_PLANS } from "./plans";

export type StepType = "krt" | "repair" | "nudge" | "fill" | "pairfix" | "escape" | "planes" | "pour";

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
}

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
const REP = (rip: string[], p = "rip-sig"): Step => ({ type: "repair", rip, plan: plan(p), planName: p });

/** The host routers a `fill` step can name (the tools package's hostFill runs exactly these). */
export const FILL_ROUTERS = ["tracemaker", "freerouting", "fab_router"] as const;

type Builder = (arg: string) => Step[];
export const ACTIONS: Record<string, { help: string; steps: Builder | null }> = {
  finish: { help: "route the opens; nothing is ripped", steps: () => [K("finish")] },
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
/** The box's numbers as written, once each is checked. */
const boxArgs = (action: string, s: string): string[] => (box(action, s), s.split(","));

const NUDGE = /^([^@]+)@([-\d.]+),([-\d.]+)(?:@([\d./]+))?(?:~([\d.]+))?$/;
const TURN = /^([^@]+)()()@([\d./]+)(?:~([\d.]+))?$/;

/** Action string to steps: `a+b` chains actions; `name:arg` passes an argument. */
export function stepsFor(action: string): Step[] {
  const steps: Step[] = [];
  const fences: Array<{ name: string; box: number[]; nets: string }> = [];
  const parts = action
    .split("+")
    .map((p) => (p.split(":")[0] === "pairs-fix" ? ((r) => `tighten${r}+reroute${r}+shorts+tighten${r}`)(p.includes(":") ? ":" + p.slice(p.indexOf(":") + 1) : "") : p))
    .join("+")
    .split("+");
  for (const part of parts) {
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
    if (fences.length)
      for (let k = first; k < steps.length; k++) {
        const s = steps[k]!;
        if (s.plan) steps[k] = { ...s, plan: { ...s.plan, fences: [...((s.plan["fences"] as unknown[]) ?? []), ...fences] } };
      }
  }
  return steps;
}

export function actionHelp(): string[] {
  return [...Object.entries(ACTIONS).map(([k, v]) => `${k.padEnd(10)} ${v.help}`), "chain with '+', e.g. taps+a7"];
}

/** Last-mile order of a board (WORKFLOW.md section 3); the agent decides what to try, the bench judges. */
export const LASTMILE_ORDER = "rip -> taps -> pairs-all -> leg | blockers:1.0 (try both in parallel) -> a7 -> bundle:REGEX per pair bundle -> pairs -> validate; then crossings, fit, nudge";
