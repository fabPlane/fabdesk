/**
 * KiCadRoutingTools plans: the generic plan templates, and their expansion against one board (net classes, pairs,
 * layers, aliases from the board's acceptance). Port of `route_krt.board_plan` / `expand`, `boardctx` helpers.
 */
import type { Acceptance, NetClassSpec } from "../requirements";
import { planeLayerNames } from "../requirements";

const STACK8 = ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "In5.Cu", "In6.Cu", "B.Cu"];
const LEGACY_PLANES = ["In1.Cu", "In6.Cu"];

export interface PlanStage {
  name: string;
  tool: string;
  args?: string[];
  each_pair_class?: boolean;
  env?: Record<string, string>;
  [k: string]: unknown;
}
export interface Fence {
  name?: string;
  box: [number, number, number, number];
  nets: string;
  layers?: string[];
}
export interface KrtPlan {
  note?: string;
  krt?: { root?: string };
  aliases?: Array<[string, string]> | "@auto";
  unaliases?: Array<[string, string]>;
  common?: string[];
  env?: Record<string, string>;
  merge?: "add" | "replace";
  fences?: Fence[];
  bundle?: string;
  stages: PlanStage[];
}
export type ExpandedPlan = Omit<KrtPlan, "aliases"> & { aliases: Array<[string, string]>; unaliases: Array<[string, string]> };

/** The four generic plans (flow/plans in the toolkit): resolve everything board-specific from the acceptance at run time. */
export const BUILTIN_PLANS: Record<string, unknown> = {
  rank: {
    note: "rank a placement seed: each pair class as pairs (escape F/B cost 5), then everything; class widths, 0.9 mm necks",
    common: ["--escalation", "off", "--no-fix-drc-settings"],
    aliases: "@auto",
    stages: [
      {
        name: "pairs",
        tool: "route_diff",
        each_pair_class: true,
        args: ["--nets", "@pairs={class}", "--layers", "@pair-layers", "--layer-costs", "@pair-costs=5", "--track-width", "@pair-width", "--diff-pair-gap", "@pair-gap"],
      },
      { name: "all", tool: "route", args: ["--layers", "@layers", "--neckdown-length", "0.9", "--neckdown-taper-length", "0"] },
    ],
  },
  finish: {
    note: "finish a routed board: only open connections",
    common: ["--escalation", "off", "--no-fix-drc-settings"],
    aliases: "@auto",
    stages: [{ name: "finish", tool: "route", args: ["--layers", "@layers", "--neckdown-length", "0.9", "--neckdown-taper-length", "0"] }],
    merge: "replace",
  },
  finish_fine: {
    note: "fine-grid finish",
    common: ["--escalation", "off", "--no-fix-drc-settings"],
    aliases: "@auto",
    stages: [{ name: "finish-g", tool: "route", args: ["--layers", "@layers", "--neckdown-length", "0.9", "--neckdown-taper-length", "0", "--grid-step", "0.05"] }],
    merge: "replace",
  },
  tm: {
    note: "generic TraceMaker pipeline: every pair as a session stage (F/B cost 20, plane layers closed), then the CLI for the rest with no neck-down on F/B-only power",
    session: [
      { name: "pairs", first: true, work: 50000000, nets: "@pairs", hints: { layers: { no_tracks: [], cost: { "F.Cu": 20, "B.Cu": 20 } } }, options: { soft_zones: true, diff_pairs: true } },
    ],
    cli: { work: 50000000, no_neck: "@outer_only_power" },
  },
};

// ---------------------------------------------------------------- board context (boardctx.py)

type Classes = Record<string, NetClassSpec>;

export function profilePlanes(acc: Acceptance): string[] {
  const sp = acc.stack_policy ?? ({} as Acceptance["stack_policy"]);
  const legacy = acc.schema === "C6_ACCEPTANCE_V1";
  return sp.plane_layers ? planeLayerNames(sp.plane_layers) : legacy ? LEGACY_PLANES : [];
}

/** Copper layers tracks may use: the acceptance's copper layers minus its no-track layers (default: the plane layers). */
export function signalLayers(acc: Acceptance): string[] {
  const sp = acc.stack_policy ?? ({} as Acceptance["stack_policy"]);
  const no = new Set(sp.no_track_layers ?? profilePlanes(acc));
  return (sp.copper_layers ?? STACK8).filter((l) => !no.has(l));
}

export function pairClasses(acc: Acceptance): Classes {
  return Object.fromEntries(Object.entries(acc.net_classes.classes).filter(([, c]) => c.pairs?.length));
}

export function powerClasses(acc: Acceptance): Classes {
  return Object.fromEntries(Object.entries(acc.net_classes.classes).filter(([k]) => k.startsWith("PWR_")));
}

/** Python's `re.escape`. */
export function pyReEscape(s: string): string {
  return s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
}

/** (aliases, unaliases) for pairs KRT cannot pair by suffix: `...P / ...M` becomes `...P / ...N` in its copy. */
export function autoAliases(acc: Acceptance): { aliases: Array<[string, string]>; unaliases: Array<[string, string]> } {
  const aliases: Array<[string, string]> = [];
  const unaliases: Array<[string, string]> = [];
  const exact = (name: string) => String.raw`(?:(?<=")|^)` + pyReEscape(name) + String.raw`(?="|$)`;
  for (const c of Object.values(pairClasses(acc)))
    for (const [p, n] of c.pairs!) {
      const m = /^(.*)M(\)?)$/s.exec(n);
      if (/DM\)?$/.test(n)) continue; // KRT pairs DP/DM by itself
      if (m && p === m[1] + "P" + m[2]) {
        const nn = m[1] + "N" + m[2];
        aliases.push([exact(n), nn]);
        unaliases.push([exact(nn), n]);
      }
    }
  return { aliases, unaliases };
}

export function applyAliases(text: string, aliases: ReadonlyArray<readonly [string, string]>): string {
  for (const [pat, rep] of aliases) text = text.replace(new RegExp(pat, "gm"), () => rep);
  return text;
}

/** Net glob (`*`, `?`) to a regex. */
export function globRe(g: string): RegExp {
  return new RegExp("^" + [...g].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"))).join("") + "$", "s");
}

// ---------------------------------------------------------------- expansion (route_krt.board_plan)

/** Resolve the board-context macros so one plan serves every board. */
export function boardPlan(plan: KrtPlan, acc: Acceptance): ExpandedPlan {
  const sig = signalLayers(acc);
  const pcs = pairClasses(acc);
  const auto = (plan.aliases ?? "@auto") === "@auto";
  const al = auto ? autoAliases(acc).aliases : (plan.aliases as Array<[string, string]>);
  const rename = (n: string) => {
    for (const [pat, rep] of al) n = n.replace(new RegExp(pat, "gm"), () => rep);
    return n;
  };
  const order = (ls: Set<string>) => sig.filter((l) => ls.has(l));
  const players = (cs: NetClassSpec[]) => order(new Set(cs.flatMap((c) => [...(c.escape_layers ?? []), ...(c.layers ?? [])])));
  const pcosts = (cs: NetClassSpec[], n: string) => {
    const inner = new Set(cs.flatMap((c) => c.layers ?? []));
    return players(cs).map((l) => (inner.has(l) && l !== "F.Cu" && l !== "B.Cu" ? "1" : n));
  };
  const sub = (args: string[], c?: NetClassSpec, cname?: string): string[] => {
    const out: string[] = [];
    for (let tkn of args) {
      if (cname && tkn.includes("{class}")) tkn = tkn.replaceAll("{class}", cname);
      if (tkn === "@layers") out.push(...sig);
      else if (tkn.startsWith("@outer-costs=")) {
        const [o, i] = tkn.split("=")[1]!.split(",") as [string, string];
        out.push(...sig.map((l) => (l === "F.Cu" || l === "B.Cu" ? o : i)));
      } else if (tkn === "@pair-layers" && c) out.push(...players([c]));
      else if (tkn.startsWith("@pair-costs=") && c) out.push(...pcosts([c], tkn.split("=")[1]!));
      else if (tkn === "@pair-width" && c) out.push(String(c.diff_pair_width));
      else if (tkn === "@pair-gap" && c) out.push(String(c.diff_pair_gap));
      else if (tkn === "@pair-rules" || tkn === "@pair-rules-all") {
        const cs = tkn === "@pair-rules" && c ? [c] : Object.values(pcs);
        const rr = cs.flatMap((x) => ((x as { router_rules?: RouterRules }).router_rules ? [(x as { router_rules: RouterRules }).router_rules] : []));
        if (rr.length) {
          const nets = cs.filter((x) => (x as { router_rules?: unknown }).router_rules).flatMap((x) => x.pairs!.flatMap((pr) => pr.map(rename)));
          if (rr.some((r) => r.clearance !== undefined)) out.push("--clearance", String(Math.max(...rr.flatMap((r) => (r.clearance !== undefined ? [r.clearance] : [])))));
          const ka = rr.flatMap((r) => (r.keep_away ? [r.keep_away] : []));
          if (ka.length) {
            const vic = [...new Set(ka.flatMap((k) => k.nets))].sort();
            out.push("--keep-away", `${nets.map((n) => n.replaceAll(" ", "?")).join(",")}:${vic.join(",")}:${Math.max(...ka.map((k) => k.mm))}`, "--keep-away-cost", "5", "--keep-away-free", "0.8");
          }
        }
      } else if (tkn === "@pair-layers-all") out.push(...players(Object.values(pcs)));
      else if (tkn.startsWith("@pair-costs-all=")) out.push(...pcosts(Object.values(pcs), tkn.split("=")[1]!));
      else if (tkn.endsWith("=*") && tkn.startsWith("@")) out.push(...Object.keys(pcs).map((k) => tkn.slice(0, -1) + k));
      else out.push(tkn);
    }
    return out;
  };
  const stages: PlanStage[] = [];
  for (const st of plan.stages ?? []) {
    if (st.each_pair_class) {
      for (const [k, c] of Object.entries(pcs)) {
        const { each_pair_class: _e, ...rest } = st;
        stages.push({ ...rest, name: `${st.name}-${k.toLowerCase()}`, args: sub(st.args ?? [], c, k) });
      }
    } else stages.push({ ...st, args: sub(st.args ?? []) });
  }
  const { aliases: _a, ...rest } = plan;
  const un = auto ? autoAliases(acc).unaliases : (plan.unaliases ?? []);
  return { ...rest, stages, aliases: al, unaliases: un };
}

/**
 * `--layer-costs` an outer layer gets when a step keeps it out of reach (the cost agents set by hand on F/B on jetson,
 * 2026-11-14; inner layers stayed at 1).
 */
export const AVOID_LAYER_COST = 10;
const COPPER_LAYER = /^(F|B|In\d+)\.Cu$/;
const OUTER_LAYERS = new Set(["F.Cu", "B.Cu"]);
const COST = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * One stage's expanded arguments with `avoid` kept out of reach (fabdesk, the last mile's `~avoid` retry): an inner
 * layer is left out of `--layers` (and its `--layer-costs` entry with it); an outer layer gets a cost of at least
 * AVOID_LAYER_COST, since leaving F/B out makes KRT write no board where pads sit on them. A stage keeps at least one
 * inner layer: when every inner layer it routes on is to be avoided, they are costed instead of left out. A negative
 * (forbidden) cost stays as it is. A stage without `--layers` is unchanged.
 */
export function avoidLayerArgs(args: readonly string[], avoid: readonly string[]): { args: string[]; removed: string[]; costed: string[] } {
  const at = args.indexOf("--layers");
  if (at < 0 || !avoid.length) return { args: [...args], removed: [], costed: [] };
  let end = at + 1;
  while (end < args.length && COPPER_LAYER.test(args[end]!)) end++;
  const layers = args.slice(at + 1, end);
  const ca = args.indexOf("--layer-costs");
  let cend = ca + 1;
  if (ca >= 0) while (cend < args.length && COST.test(args[cend]!)) cend++;
  const given = ca >= 0 ? args.slice(ca + 1, cend) : [];
  const costs = layers.map((_, i) => given[i] ?? "1");
  const want = new Set(avoid);
  const inner = layers.filter((l) => !OUTER_LAYERS.has(l));
  const drop = new Set(inner.some((l) => !want.has(l)) ? inner.filter((l) => want.has(l)) : []);
  const keptLayers: string[] = [];
  const keptCosts: string[] = [];
  const costed: string[] = [];
  layers.forEach((l, i) => {
    if (drop.has(l)) return;
    let c = costs[i]!;
    if (want.has(l) && Number(c) >= 0 && Number(c) < AVOID_LAYER_COST) {
      c = String(AVOID_LAYER_COST);
      costed.push(l);
    }
    keptLayers.push(l);
    keptCosts.push(c);
  });
  const removed = layers.filter((l) => drop.has(l));
  if (!removed.length && !costed.length) return { args: [...args], removed, costed };
  // rebuild: the layer list in place, the cost list in place (or right after the layers when the stage had none)
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (i === at) {
      out.push("--layers", ...keptLayers);
      if (ca < 0) out.push("--layer-costs", ...keptCosts);
      i = end - 1;
    } else if (i === ca) {
      out.push("--layer-costs", ...keptCosts);
      i = cend - 1;
    } else out.push(args[i]!);
  }
  return { args: out, removed, costed };
}

/** `avoidLayerArgs` on every stage of an expanded plan; `record` says per stage what was left out and what was costed. */
export function avoidLayersInPlan(plan: ExpandedPlan, avoid: readonly string[]): { plan: ExpandedPlan; record: Array<{ stage: string; removed: string[]; costed: string[] }> } {
  const record: Array<{ stage: string; removed: string[]; costed: string[] }> = [];
  const stages = plan.stages.map((st) => {
    const r = avoidLayerArgs(st.args ?? [], avoid);
    if (r.removed.length || r.costed.length) record.push({ stage: st.name, removed: r.removed, costed: r.costed });
    return { ...st, args: r.args };
  });
  return { plan: { ...plan, stages, note: `${plan.note ? plan.note + " " : ""}[fabdesk: kept out of reach: ${avoid.join(", ")}]` }, record };
}

interface RouterRules {
  clearance?: number;
  keep_away?: { nets: string[]; mm: number };
}

export interface Selectors {
  /** `acceptance.json` of the board being routed, for `@pairs-todo`. */
  pairsToReroute: string[][];
  /** Nets a rip or nudge cut (rip.json `nets`, nudge.json `cut_nets`). */
  cutNets: string[];
  /** Nets open before rip_items cut their blockers (rip.json `open_before`). */
  openBefore: string[];
}

/**
 * Expand the stage-level selectors (`@not-pairs`, `@pairs=CLASS`, `@bundle=CLASS` ...) to net names in KRT's naming.
 * Returns null when every selector asked for nets and none was found (the stage is skipped).
 */
export function expandArgs(args: string[], plan: ExpandedPlan, acc: Acceptance, sel: Selectors): string[] | null {
  const classes = acc.net_classes.classes;
  const al = plan.aliases;
  const ren = (n: string) => {
    for (const [pat, rep] of al) n = n.replace(new RegExp(pat, "gm"), () => rep);
    return n;
  };
  const pairNets: Record<string, string[]> = {};
  const notPairs: string[] = [];
  for (const [cname, c] of Object.entries(classes))
    for (const pair of c.pairs ?? [])
      for (const raw of pair) {
        const net = ren(raw);
        notPairs.push("!" + net);
        (pairNets[cname] ??= []).push(net);
      }
  const tapW: Record<string, number> = {};
  for (const [n, d] of Object.entries(acc.net_classes.tap_pads ?? {})) {
    if (n.startsWith("_") || typeof d !== "object") continue;
    tapW[n] = Math.max(...Object.values(d).map((t) => t.width));
  }
  const out: string[] = [];
  let asked = 0;
  let found = 0;
  const take = (got: string[]) => {
    asked++;
    if (got.length) found++;
    out.push(...got);
  };
  const names = (cls: string) => {
    const v = pairNets[cls];
    if (!v) throw new Error(`plan names pair class ${cls}, which the board does not have`);
    return v;
  };
  for (const t of args) {
    if (t === "@not-pairs") out.push(...notPairs);
    else if (t === "@not-power") out.push(...Object.entries(classes).filter(([k, c]) => k.startsWith("PWR_") && (c.inner_track_width ?? null) === null).flatMap(([, c]) => c.nets!.map((n) => "!" + n)));
    else if (t.startsWith("@pairs=")) out.push(...names(t.split("=")[1]!));
    else if (t.startsWith("@bundle=")) {
      const ns = names(t.split("=")[1]!);
      const rx = new RegExp(plan.bundle ?? "$^");
      take(ns.filter((n, i) => rx.test(n) || rx.test(ns[i ^ 1] ?? "")));
    } else if (t.startsWith("@pairs-todo=")) {
      const todo = new Set(sel.pairsToReroute.flat().map(ren));
      take(names(t.split("=")[1]!).filter((n) => todo.has(n)));
    } else if (t.startsWith("@cut-pairs=")) {
      const cut = new Set(sel.cutNets.map(ren));
      const ns = names(t.split("=")[1]!);
      take(ns.filter((n, i) => cut.has(n) || cut.has(ns[i ^ 1] ?? "")));
    } else if (t === "@open-before") take(sel.openBefore.map(ren));
    else if (t.startsWith("@tap-nets=")) {
      const w = Number(t.split("=")[1]);
      take(Object.entries(tapW).filter(([, v]) => Math.abs(v - w) < 1e-6).map(([n]) => n));
    } else out.push(t);
  }
  return asked && !found ? null : out;
}
