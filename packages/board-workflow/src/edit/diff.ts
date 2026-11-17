/** Planned vs collateral change: proves the edit changed what the plan said and nothing else (parts, poses, pin nets, copper). */
import { parseSexpr, removeSpans, topLevelSpans, type Span } from "../sexpr";
import type { Segment } from "../board";
import { boardModel } from "./impact";
import { round } from "./fmt";
import type { EditPlan } from "./plan";
import type { ApplyLog } from "./apply";
import type { ImpactReport } from "./impact";

export interface BoardDiff {
  removed: string[];
  added: string[];
  moved: string[];
  pin_net_changed: Array<Record<string, Record<string, [string, string | null]>>>;
  copper_changed_nets: Record<string, [number, number]>;
  vias: [number, number];
}

const length = (s: Segment) => Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]);
const sameKeys = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

export function diffBoards(beforeText: string, afterText: string): BoardDiff {
  const b = boardModel(beforeText, "before").board;
  const a = boardModel(afterText, "after").board;
  const fb = b.footprints, fa = a.footprints;
  const out: BoardDiff = {
    removed: [...fb.keys()].filter((r) => !fa.has(r)).sort(),
    added: [...fa.keys()].filter((r) => !fb.has(r)).sort(),
    moved: [], pin_net_changed: [], copper_changed_nets: {}, vias: [b.vias.length, a.vias.length],
  };
  for (const r of [...fb.keys()].filter((x) => fa.has(x)).sort()) {
    const x = fb.get(r)!, y = fa.get(r)!;
    if (round(x.x, 4) !== round(y.x, 4) || round(x.y, 4) !== round(y.y, 4) || x.rot !== y.rot || x.layer !== y.layer) out.moved.push(r);
    if (!sameKeys(x.pins, y.pins)) {
      const ch: Record<string, [string, string | null]> = {};
      for (const p of Object.keys(x.pins)) if (x.pins[p] !== y.pins[p]) ch[p] = [x.pins[p]!, y.pins[p] ?? null];
      out.pin_net_changed.push({ [r]: ch });
    }
  }
  const cb = new Map<string, number>(), ca = new Map<string, number>();
  for (const s of b.segments) cb.set(s.net, (cb.get(s.net) ?? 0) + length(s));
  for (const s of a.segments) ca.set(s.net, (ca.get(s.net) ?? 0) + length(s));
  const sb = copperSignatures(beforeText), sa = copperSignatures(afterText);
  for (const n of new Set([...sb.keys(), ...sa.keys()])) if (sb.get(n) !== sa.get(n)) out.copper_changed_nets[n] = [round(cb.get(n) ?? 0, 2), round(ca.get(n) ?? 0, 2)];
  return out;
}

/** Geometry and properties, excluding item identity and formatting. Include vias and arcs even at equal total length. */
function copperSignatures(text: string): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const kind of ["segment", "via", "arc"]) for (const sp of topLevelSpans(text, kind)) {
    const node = parseSexpr(text.slice(sp.start, sp.end));
    const net = node.find((n) => Array.isArray(n) && n[0] === "net");
    if (!Array.isArray(net) || !net[1]) continue;
    const name = String(net[1]);
    const signature = JSON.stringify(node.filter((n) => !Array.isArray(n) || !["uuid", "tstamp"].includes(String(n[0]))));
    (out.get(name) ?? out.set(name, []).get(name)!).push(signature);
  }
  return new Map([...out].map(([net, items]) => [net, items.sort().join(";")]));
}

export interface Churn {
  unplanned_moved: string[];
  planned_parts_moved: string[];
  collateral_nets: number;
  collateral_mm: number;
  collateral_detail: Record<string, [number, number]>;
  planned_nets: number;
}

/** Split a diff into planned and collateral change, from an apply ledger (`edit.json`). */
export function churn(d: BoardDiff, ledger: { applied: ApplyLog; impact: ImpactReport; plan?: EditPlan }): Churn {
  const ap = ledger.applied;
  const mv = ap.moves;
  const imp = ledger.impact;
  const parts = new Set<string>();
  const kinds = ["moved", "carried", "near", "displaced"] as const;
  for (const k of kinds) for (const m of mv?.[k] ?? []) parts.add(m.ref);
  const nets = new Set<string>([...(ledger.plan?.routeAgain ?? []), ...(mv?.cut_nets ?? []), ...(mv?.internal_nets_moved ?? []), ...imp.copper.delete_on_nets, ...imp.copper.prune_on_nets]);
  for (const n of [...(ap.pad_cut?.cut_nets ?? []), ...(ap.landing?.cut_nets ?? []), ...(ap.copper?.nets ?? []), ...(ap.stack?.nets ?? [])]) nets.add(n);
  for (const c of ap.net_changes) {
    nets.add(c.from);
    nets.add(c.to);
  }
  for (const a of imp.adds ?? []) for (const n of Object.values(a["pins"] as Record<string, string>)) nets.add(n);
  for (const [n, v] of Object.entries(imp.nets)) if (v.status.startsWith("reconnect")) nets.add(n);
  for (const k of kinds) for (const m of ap.landing?.[k] ?? []) parts.add(m.ref);
  const extra = Object.fromEntries(Object.entries(d.copper_changed_nets).filter(([n]) => !nets.has(n)));
  return {
    unplanned_moved: d.moved.filter((r) => !parts.has(r)).sort(),
    planned_parts_moved: d.moved.filter((r) => parts.has(r)).sort(),
    collateral_nets: Object.keys(extra).length,
    collateral_mm: round(Object.values(extra).reduce((a, [x, y]) => a + Math.abs(y - x), 0), 2),
    collateral_detail: extra,
    planned_nets: nets.size,
  };
}

/** Copper of `nets` in `boardText` replaced by their copper in `sourceText` (nets the edit did not touch). */
export function revertNets(sourceText: string, boardText: string, nets: Iterable<string>): string {
  const want = new Set(nets);
  const pick = (txt: string): Span[] =>
    ["segment", "via", "arc"].flatMap((k) => topLevelSpans(txt, k)).filter((s) => want.has(/\(net "([^"]*)"\)/.exec(txt.slice(s.start, s.end))?.[1] ?? ""));
  const keep = pick(sourceText).map((s) => "\n  " + sourceText.slice(s.start, s.end).trim()).join("");
  const dst = removeSpans(boardText, pick(boardText));
  const end = dst.trimEnd().lastIndexOf(")");
  return dst.slice(0, end).trimEnd() + keep + "\n)\n";
}
