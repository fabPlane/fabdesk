/**
 * Running a KiCadRoutingTools script with some of its module constants changed, without editing the installed tree (KRT
 * installs are hash-locked; see docs/routers.md). A plan stage names the constants (`krt_overrides`, module -> name ->
 * value); routeKrt then starts the stage through a small Python wrapper written beside the run (`krt_override.py`), which
 * imports each module from the script's folder exactly as the script would, checks the constant exists and keeps its
 * type, sets it, and runs the script as `__main__` with the stage's argv. A missing module or constant stops the stage
 * (exit 3, `KRT_OVERRIDE_ERROR:` in its log) before anything is routed: a future KRT that renames a constant fails by
 * name instead of silently routing with its own default.
 *
 * The one use today is the last mile's `!short` modifier: KRT's `diff_pair_multipoint` routes a pair leg single-ended
 * when it has less than max(DIFF_PAIR_MIN_COUPLED_SETBACKS x the centerline setback, DIFF_PAIR_MIN_COUPLED_FLOOR_MM) of
 * coupled run ("electrically short"); a 0.5 mm pitch connector fan-out is all such legs, so the pairs come out routed
 * apart. Lowering the two constants to 1 setback / 1 mm is what the toolkit agent did by hand (a copied py_router) to
 * pass the eval's HDMI task. Both names exist in the KRT fabdesk pins (0.23.8, py_router/diff_pair_multipoint.py).
 */
import type { ExpandedPlan, PlanStage } from "./plan";

/** module -> constant -> value (JSON scalars). */
export type KrtOverrides = Record<string, Record<string, number | boolean | string>>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A stage's `krt_overrides` checked (module and constant names are Python identifiers, values JSON scalars); throws by name. */
export function checkKrtOverrides(o: unknown, what: string): KrtOverrides {
  if (o === undefined || o === null) return {};
  if (typeof o !== "object" || Array.isArray(o)) throw new Error(`${what}: krt_overrides is {module: {CONSTANT: value}}`);
  const out: KrtOverrides = {};
  for (const [mod, consts] of Object.entries(o as Record<string, unknown>)) {
    if (!MODULE.test(mod)) throw new Error(`${what}: krt_overrides module '${mod}' is not a Python module name`);
    if (!consts || typeof consts !== "object" || Array.isArray(consts)) throw new Error(`${what}: krt_overrides.${mod} is {CONSTANT: value}`);
    for (const [name, v] of Object.entries(consts as Record<string, unknown>)) {
      if (!IDENT.test(name)) throw new Error(`${what}: krt_overrides.${mod}: '${name}' is not a Python name`);
      if (!((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || typeof v === "string")) throw new Error(`${what}: krt_overrides.${mod}.${name} must be a number, boolean or string`);
      (out[mod] ??= {})[name] = v;
    }
  }
  return out;
}

/** The wrapper's `--set MODULE.NAME=JSON` arguments, in a stable order. */
export function krtOverrideArgs(o: KrtOverrides): string[] {
  const out: string[] = [];
  for (const mod of Object.keys(o).sort()) for (const name of Object.keys(o[mod]!).sort()) out.push("--set", `${mod}.${name}=${JSON.stringify(o[mod]![name])}`);
  return out;
}

/** True when `o` sets at least one constant. */
export const hasKrtOverrides = (o: KrtOverrides | undefined): o is KrtOverrides => !!o && Object.values(o).some((c) => Object.keys(c).length > 0);

/**
 * The command line of one KRT stage: the script directly, or through the wrapper when the stage overrides constants
 * (`python -E -s krt_override.py --set M.N=V ... -- SCRIPT ARGS...`). The script's own argv is unchanged either way.
 */
export function krtStageCommand(python: readonly string[], script: string, args: readonly string[], o?: { wrapper: string; overrides: KrtOverrides }): string[] {
  if (!o || !hasKrtOverrides(o.overrides)) return [...python, script, ...args];
  return [...python, o.wrapper, ...krtOverrideArgs(o.overrides), "--", script, ...args];
}

/** File name of the wrapper routeKrt writes beside the run (one per run, shared by its stages). */
export const KRT_OVERRIDE_FILE = "krt_override.py";

/**
 * The wrapper. Kept as plain Python with no imports beyond the standard library; KRT's venv runs it with `-E -s`. It
 * prints one `KRT_OVERRIDES: {...}` line (old and new value of each constant) that routeKrt keeps in the stage record.
 */
export const KRT_OVERRIDE_SCRIPT = `"""fabdesk: run a KiCadRoutingTools script with module constants overridden, leaving the installed tree untouched.

    python -E -s krt_override.py --set MODULE.NAME=JSON [--set ...] -- SCRIPT [ARGS...]

Each MODULE is imported from SCRIPT's folder (as SCRIPT itself would import it), NAME must exist there and keep its
type, and is set before SCRIPT runs as __main__ with ARGS as its argv. A missing module or constant is an error
(exit 3, nothing routed), never ignored. Written by fabdesk (packages/board-workflow/src/layout/krt-override.ts).
"""
import importlib
import json
import os
import runpy
import sys

_MISSING = object()


def fail(msg):
    print("KRT_OVERRIDE_ERROR: " + msg, file=sys.stderr, flush=True)
    sys.exit(3)


def coerce(spec, old, value):
    if isinstance(old, bool) or isinstance(value, bool):
        if isinstance(old, bool) and isinstance(value, bool):
            return value
    elif isinstance(old, (int, float)) and isinstance(value, (int, float)):
        return float(value) if isinstance(old, float) else value
    elif isinstance(old, str) and isinstance(value, str):
        return value
    fail("%s: the constant is %s %r, the override %s %r" % (spec, type(old).__name__, old, type(value).__name__, value))


def main(argv):
    sets = []
    i = 0
    while i < len(argv) and argv[i] != "--":
        if argv[i] != "--set" or i + 1 >= len(argv):
            fail("usage: krt_override.py --set MODULE.NAME=JSON ... -- SCRIPT [ARGS...] (got %r)" % argv[i])
        spec = argv[i + 1]
        i += 2
        key, eq, raw = spec.partition("=")
        mod, dot, name = key.rpartition(".")
        if not eq or not dot or not mod or not name:
            fail("--set %r: expected MODULE.NAME=JSON" % spec)
        try:
            value = json.loads(raw)
        except ValueError:
            fail("--set %r: the value is not JSON" % spec)
        sets.append((key, mod, name, value))
    if i + 1 >= len(argv):
        fail("no script after --")
    if not sets:
        fail("nothing to override (no --set)")
    script = os.path.abspath(argv[i + 1])
    if not os.path.isfile(script):
        fail("no script %s" % script)
    sys.argv = [script] + argv[i + 2:]
    # as \`python SCRIPT\` has it: the script's folder first on the path (not this wrapper's)
    sys.path[0] = os.path.dirname(script)
    applied = {}
    for key, mod, name, value in sets:
        try:
            m = importlib.import_module(mod)
        except ImportError as e:
            fail("cannot import %s beside %s: %s" % (mod, script, e))
        old = getattr(m, name, _MISSING)
        if old is _MISSING:
            fail("%s has no %s (KiCadRoutingTools changed?); the stage was not run" % (mod, name))
        new = coerce(key, old, value)
        setattr(m, name, new)
        # a module already loaded that copied the constant by \`from MODULE import NAME\` gets the new value too
        copies = sorted(k for k, other in list(sys.modules.items()) if other is not None and other is not m and getattr(other, name, _MISSING) is old)
        for k in copies:
            setattr(sys.modules[k], name, new)
        applied[key] = {"old": old, "new": new, **({"copies": copies} if copies else {})}
    print("KRT_OVERRIDES: " + json.dumps(applied, sort_keys=True), flush=True)
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main(sys.argv[1:])
`;

/** What `!short` sets: KRT's short-leg rule lowered from max(5 x setback, 3 mm) to max(1 x setback, 1 mm). */
export const SHORT_LEG_RULE = { setbacks: 1.0, floorMm: 1.0 } as const;
export const SHORT_LEG_MODULE = "diff_pair_multipoint";
export const shortLegOverrides = (r: { setbacks: number; floorMm: number } = SHORT_LEG_RULE): KrtOverrides => ({
  [SHORT_LEG_MODULE]: { DIFF_PAIR_MIN_COUPLED_SETBACKS: r.setbacks, DIFF_PAIR_MIN_COUPLED_FLOOR_MM: r.floorMm },
});

/** Options a last-mile step applies to the pair stages (`route_diff`) of its KRT plan. */
export interface PairStageOptions {
  /** Couple the short fan-out legs too: KRT's short-leg rule lowered (`!short`). */
  shortLegs?: { setbacks: number; floorMm: number };
  /** P/N length matching inside each pair at this tolerance, mm (`--diff-pair-intra-match --length-match-tolerance`, `!match`). */
  intraMatch?: number;
  /**
   * `--layer-costs` of the outer layers (F.Cu, B.Cu) in the pair stages (`!outer=COST`; the templates use 20, which keeps
   * pairs off the outer layers where a connector's fan-out and its ESD parts sit).
   */
  outerCost?: number;
}

export const hasPairStageOptions = (o: PairStageOptions | undefined): o is PairStageOptions => !!o && (!!o.shortLegs || o.intraMatch !== undefined || o.outerCost !== undefined);

const LAYER = /^(F|B|In\d+)\.Cu$/;
const NUM = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
/**
 * One stage's args with the outer layers (F.Cu, B.Cu) of `--layers` at `cost` in `--layer-costs` (added after the layers,
 * inner layers at 1, when the stage had none). A forbidden (negative) cost stays. A stage without `--layers` is unchanged.
 */
export function outerCostArgs(args: readonly string[], cost: number): string[] {
  const at = args.indexOf("--layers");
  if (at < 0) return [...args];
  let end = at + 1;
  while (end < args.length && LAYER.test(args[end]!)) end++;
  const layers = args.slice(at + 1, end);
  const ca = args.indexOf("--layer-costs");
  let cend = ca + 1;
  if (ca >= 0) while (cend < args.length && NUM.test(args[cend]!)) cend++;
  const given = ca >= 0 ? args.slice(ca + 1, cend) : [];
  const costs = layers.map((l, i) => {
    const c = given[i] ?? "1";
    return (l === "F.Cu" || l === "B.Cu") && !(Number(c) < 0) ? String(cost) : c;
  });
  if (ca >= 0) return [...args.slice(0, ca + 1), ...costs, ...args.slice(cend)];
  return [...args.slice(0, end), "--layer-costs", ...costs, ...args.slice(end)];
}

/** The tool name of KRT's pair router: the stages `PairStageOptions` apply to. */
export const PAIR_STAGE_TOOL = "route_diff";

/** Plan stages (unexpanded or expanded) that route pairs as pairs. */
export const pairStages = (stages: readonly PlanStage[]) => stages.filter((s) => s.tool === PAIR_STAGE_TOOL);

/** One stage's args with intra-pair matching at `tol` mm: the flag added once, the tolerance set (replaced when present). */
export function intraMatchArgs(args: readonly string[], tol: number): string[] {
  const out = [...args];
  if (!out.includes("--diff-pair-intra-match")) out.push("--diff-pair-intra-match");
  const at = out.indexOf("--length-match-tolerance");
  if (at >= 0 && at + 1 < out.length) out[at + 1] = String(tol);
  else out.push("--length-match-tolerance", String(tol));
  return out;
}

/** What `PairStageOptions` did to one pair stage (krt.json `pair_options`). */
export interface PairOptionsRecord {
  stage: string;
  krt_overrides?: KrtOverrides;
  args_added?: string[];
  outer_cost?: number;
}

/**
 * `PairStageOptions` on every `route_diff` stage of an expanded plan: `krt_overrides` merged into the stage (so plan.json
 * shows what ran) and the matching arguments added. Throws when the plan has no pair stage: the modifier would do nothing.
 */
export function pairOptionsInPlan(plan: ExpandedPlan, o: PairStageOptions): { plan: ExpandedPlan; record: PairOptionsRecord[] } {
  if (!pairStages(plan.stages).length) throw new Error(`the plan has no ${PAIR_STAGE_TOOL} stage, so ${pairOptionsText(o)} would do nothing`);
  const record: PairOptionsRecord[] = [];
  const stages = plan.stages.map((st) => {
    if (st.tool !== PAIR_STAGE_TOOL) return st;
    const next: PlanStage = { ...st };
    const rec: PairOptionsRecord = { stage: st.name };
    if (o.shortLegs) {
      const prev = checkKrtOverrides(st["krt_overrides"], st.name);
      const add = shortLegOverrides(o.shortLegs);
      const merged: KrtOverrides = { ...prev };
      for (const [m, c] of Object.entries(add)) merged[m] = { ...(merged[m] ?? {}), ...c };
      next["krt_overrides"] = merged;
      rec.krt_overrides = add;
    }
    if (o.intraMatch !== undefined) {
      next.args = intraMatchArgs(next.args ?? [], o.intraMatch);
      rec.args_added = ["--diff-pair-intra-match", "--length-match-tolerance", String(o.intraMatch)];
    }
    if (o.outerCost !== undefined) {
      next.args = outerCostArgs(next.args ?? [], o.outerCost);
      rec.outer_cost = o.outerCost;
    }
    record.push(rec);
    return next;
  });
  const what = [
    o.shortLegs ? `short legs coupled (KRT short-leg rule ${o.shortLegs.setbacks} x setback / ${o.shortLegs.floorMm} mm)` : "",
    o.intraMatch !== undefined ? `intra-pair match ${o.intraMatch} mm` : "",
    o.outerCost !== undefined ? `outer layers at cost ${o.outerCost}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return { plan: { ...plan, stages, note: `${plan.note ? plan.note + " " : ""}[fabdesk: pair stages: ${what}]` }, record };
}

/** The modifiers as an action writes them (`!short!match=1!outer=2`), for messages. */
export function pairOptionsText(o: PairStageOptions): string {
  return [o.shortLegs ? "!short" : "", o.intraMatch !== undefined ? `!match=${o.intraMatch}` : "", o.outerCost !== undefined ? `!outer=${o.outerCost}` : ""].join("");
}
