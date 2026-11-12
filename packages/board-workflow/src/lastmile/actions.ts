/**
 * The last-mile action vocabulary (toolkit tools/bench.py ACTIONS and steps_for): an action string such as
 * `blockers:1.0`, `taps+a7` or `reroute:^(USB_D)$+shorts+tighten` becomes a chain of steps. Steps are data; engines run
 * them (`pairfix` in this package, router steps through a StepEngine that wraps what the host has installed).
 */
import { LASTMILE_PLANS } from "./plans";

export type StepType = "krt" | "repair" | "nudge" | "fill" | "pairfix";

export interface Step {
  type: StepType;
  /** Router plan (a copy of the toolkit's template, edited by the action), for `krt`, `repair` and `nudge` steps. */
  plan?: Record<string, unknown>;
  /** A plan file named by the caller (`plan:FILE`). */
  planFile?: string;
  /** `repair`: arguments of the rip selection (`--around-opens 1.0 --spare-pairs`). */
  rip?: string[];
  /** `nudge`: the pose moves and the gates (clearance, edge). */
  moves?: { clearance: number; edge: number; moves: NudgeMove[] };
  /** `fill`: which router fills the opens. */
  router?: string;
  /** `pairfix`: arguments (`--pairs REGEX`, `--ops mirror-force`). */
  args?: string[];
}

export interface NudgeMove {
  ref: string;
  radius: number;
  near?: [number, number];
  rotations?: number[];
}

export const SHORTS = "shorting_items,tracks_crossing,clearance";

const plan = (n: string): Record<string, unknown> => {
  const p = LASTMILE_PLANS[n];
  if (!p) throw new Error(`no plan template ${n}`);
  return structuredClone(p);
};
const K = (n: string): Step => ({ type: "krt", plan: plan(n) });
const REP = (rip: string[], p = "rip-sig"): Step => ({ type: "repair", rip, plan: plan(p) });

type Builder = (arg: string) => Step[];
export const ACTIONS: Record<string, { help: string; steps: Builder | null }> = {
  finish: { help: "route the opens; nothing is ripped", steps: () => [K("finish")] },
  rip: { help: "route the opens; signal nets may be ripped whole (pairs and wide power protected)", steps: () => [K("rip-sig")] },
  leg: {
    help: "leg-level rip with near-target blocker selection, then repair its shorts keeping the new routes",
    steps: () => [K("rip-sig-leg-nt"), REP(["--drc", SHORTS, "--spare-open-nets", "{start}"])],
  },
  blockers: { help: "blockers:R  cut all copper within R mm of each open end, route the opens first, then the cut", steps: (a) => [REP(["--around-opens", a || "1.0", "--spare-pairs"], "opens-first")] },
  window: { help: "window:X0,Y0,X1,Y1  cut the copper in a box (pairs spared), route opens first, then the cut", steps: (a) => [REP(["--window", ...a.split(","), "--spare-pairs"], "opens-first")] },
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
  fill: { help: "fill:tracemaker|fastroute  another router fills the opens, everything else fixed", steps: (a) => [{ type: "fill", router: a }] },
  nudge: { help: "nudge:REF@X,Y[@ROT[/ROT..]][~RADIUS][&REF2@..]  re-seat parts near points (pose computed, courtyard-gated), cut pairs re-routed as pairs", steps: null },
  turn: { help: "turn:REF@ROT[/ROT..][~RADIUS]  re-seat a part where it is at another rotation (see `crossings`)", steps: null },
  plan: { help: "plan:FILE  any router plan", steps: (a) => [{ type: "krt", planFile: a }] },
};

export class ActionError extends Error {}

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
      const [box, , rx] = [arg.slice(0, arg.indexOf("=")), "=", arg.slice(arg.indexOf("=") + 1)];
      fences.push({ name: `fence${fences.length}`, box: box.split(",").map(Number), nets: rx });
      continue;
    }
    const first = steps.length;
    if (name === "nudge" || name === "turn") {
      const moves: NudgeMove[] = arg.split("&").map((one) => {
        const m = (name === "nudge" ? NUDGE : TURN).exec(one);
        if (!m) throw new ActionError("nudge:REF@X,Y[@ROT[/ROT]][~RADIUS][&REF2@...]   turn:REF@ROT[/ROT][~RADIUS]");
        return {
          ref: m[1]!,
          radius: Number(m[5] || 2.5),
          ...(name === "nudge" ? { near: [Number(m[2]), Number(m[3])] as [number, number] } : {}),
          ...(m[4] ? { rotations: m[4].split("/").map(Number) } : {}),
        };
      });
      steps.push({ type: "nudge", moves: { clearance: 0.2, edge: 0.4, moves }, plan: plan("after-cut") });
    } else if (name === "bundle") {
      const at = arg.indexOf("@");
      const rx = at < 0 ? arg : arg.slice(0, at);
      const win = at < 0 ? "" : arg.slice(at + 1);
      const p = plan("pairs-todo");
      p["bundle"] = rx;
      p["note"] = `bundle ${rx}: ` + String(p["note"] ?? "");
      for (const st of p["stages"] as Array<{ args: string[] }>) st.args = st.args.map((x) => x.replace("@pairs-todo=", "@bundle="));
      steps.push(win ? { type: "repair", rip: ["--window", ...win.split(","), "--spare-pairs"], plan: p } : { type: "krt", plan: p });
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
