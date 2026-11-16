/**
 * The board's acceptance checks A1-A9, judged against its own requirements (see onboard.ts).
 * A1-A3 come from one KiCad DRC run (refilled zones, schematic parity), supplied by the caller;
 * A4-A9 are measured here from the board file. Verdicts and figures follow the toolkit's
 * `check_acceptance.py` field for field.
 */
import { padOnLayer, viaSpan, type Board, type Pad, type Segment, type Via } from "./board";
import type { Acceptance, NetClassSpec, Requirements, TapPad } from "./requirements";
import { planeLayerNames } from "./requirements";

export const CHECK_NAMES = {
  A1: "connectivity",
  A2: "drc",
  A3: "parity",
  A4: "circuit",
  A5: "anchors",
  A6: "stack",
  A7: "widths",
  A8: "pairs",
  A9: "heights",
} as const;
export type CheckCode = keyof typeof CHECK_NAMES;
export const CHECK_KEYS = [
  "A1_connectivity",
  "A2_drc",
  "A3_parity",
  "A4_circuit",
  "A5_anchors",
  "A6_stack",
  "A7_widths",
  "A8_pairs",
  "A9_heights",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

/**
 * DRC findings from the generated PWR_* class-width rules are a courtyard proxy for the neck rule; A7 judges widths.
 * Named classes (`PWR_LOGIC_3313`) count as well as numbered ones (`PWR_200`). Shared with the review's drc check.
 */
export const PWR_PROXY = /rule 'PWR_[A-Za-z0-9_]+ (outer width|inner width|neck in courtyard)'/;

/** One DRC finding as the checks read it; `items` (KiCad's affected items) is what names a courtyard overlap's footprints. */
export interface DrcFinding {
  rule: string;
  severity: string;
  description: string;
  items?: Array<{ description: string }>;
}

/** What the checks need from a KiCad DRC run (a `DrcReport` from @fabdesk/kicad fits). */
export interface DrcInput {
  violations: DrcFinding[];
  unconnected: number;
  parity: number;
}

/** A courtyard overlap the board's acceptance accepts by name: exactly two footprints, with the measured gaps and basis. */
export interface CourtyardOverlapException {
  refs: string[];
  [extra: string]: unknown;
}

/**
 * The acceptance.json `courtyard_overlap_exceptions` entry that accepts this DRC courtyards_overlap item, or null
 * (check_acceptance.courtyard_exception). Each entry names exactly two footprints; only that pair is accepted, never
 * courtyard overlaps in general. `rule` is the DRC type (`type` in KiCad's raw JSON).
 */
export function courtyardException(v: { rule?: string; type?: string; items?: Array<{ description?: string }> }, acc: Pick<Acceptance, "courtyard_overlap_exceptions">): CourtyardOverlapException | null {
  if ((v.rule ?? v.type) !== "courtyards_overlap") return null;
  const refs = new Set<string>();
  for (const i of v.items ?? []) {
    const m = /^Footprint (\S+)/.exec(i.description ?? "");
    if (m) refs.add(m[1]!);
  }
  if (refs.size !== 2) return null;
  return (acc.courtyard_overlap_exceptions ?? []).find((e) => new Set(e.refs).size === refs.size && e.refs.every((r) => refs.has(r))) ?? null;
}

export type Verdict = { pass: boolean; [field: string]: unknown };
export type AcceptanceResults = Record<CheckKey, Verdict>;

export interface AcceptanceResult {
  board: string;
  summary: Record<CheckKey, boolean>;
  results: AcceptanceResults;
  names: typeof CHECK_NAMES;
}

type Pt = [number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const length = (s: Segment) => dist(s.a, s.b);

/** Python's round(x, nd): correctly rounded decimal, ties to even. */
export function pyRound(x: number, nd: number): number {
  // toFixed rounds the exact binary value correctly; only an exact tie needs Python's half-even.
  const exact = x.toFixed(Math.min(100, nd + 40));
  const frac = exact.slice(exact.indexOf(".") + 1 + nd);
  if (/^50*$/.test(frac)) {
    const down = Number(exact.slice(0, exact.indexOf(".") + 1 + nd));
    // the last kept digit (for nd = 0 the one before the point)
    const at = nd === 0 ? exact.indexOf(".") - 1 : exact.indexOf(".") + nd;
    const last = Number(exact[at]);
    return last % 2 === 0 ? down : Number((down + Math.sign(x) * 10 ** -nd).toFixed(nd));
  }
  return Number(x.toFixed(nd));
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
  return Math.hypot(p[0] - a[0] - u * (b[0] - a[0]), p[1] - a[1] - u * (b[1] - a[1]));
}

function nearPad(p: Pt, net: string, padsByNet: Map<string, Pad[]>, extra = 1.0): boolean {
  return (padsByNet.get(net) ?? []).some((q) => dist(p, [q.x, q.y]) <= q.r + extra);
}

type El = { k: "s"; v: Segment } | { k: "v"; v: Via & { lo: number; hi: number } } | { k: "p"; v: Pad };

/**
 * True when removing segment `s` cuts off a part of the net whose pads are all tap pads allowed at
 * this width: the segment then carries only tap current. Copper joins by touching (pad extent as a
 * circle, which can only add joins, so the test errs towards "not a tap").
 */
function tapBranch(
  s: Segment,
  net: string,
  segs: Segment[],
  vias: Via[],
  padsByNet: Map<string, Pad[]>,
  taps: Record<string, Record<string, TapPad>>,
  stack: readonly string[],
): boolean {
  const tp = taps[net];
  if (!tp || !Object.keys(tp).length) return false;
  const el: El[] = [
    ...segs.filter((t) => t.net === net && t !== s).map((v): El => ({ k: "s", v })),
    ...vias
      .filter((v) => v.net === net)
      .map((v): El => {
        const [a, b] = viaSpan(v, stack);
        return { k: "v", v: { ...v, lo: stack.indexOf(a), hi: stack.indexOf(b) } };
      }),
    ...(padsByNet.get(net) ?? []).map((v): El => ({ k: "p", v })),
  ];
  const parent = el.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const touch = (x: El, y: El): boolean => {
    // order as the toolkit: pad < segment < via by tuple compare of kind letters ('p' < 's' < 'v')
    let a = x, b = y;
    if (a.k > b.k) [a, b] = [b, a];
    if (a.k === "s" && b.k === "s") {
      const u = a.v, w = b.v;
      return (
        u.layer === w.layer &&
        Math.min(segDist(u.a, w.a, w.b), segDist(u.b, w.a, w.b), segDist(w.a, u.a, u.b), segDist(w.b, u.a, u.b)) <=
          (u.w + w.w) / 2 - 1e-4
      );
    }
    if (a.k === "s" && b.k === "v") {
      const idx = stack.indexOf(a.v.layer);
      return b.v.lo <= idx && idx <= b.v.hi && segDist([b.v.x, b.v.y], a.v.a, a.v.b) <= b.v.size / 2;
    }
    if (a.k === "p" && b.k === "s")
      return padOnLayer(a.v, b.v.layer) && segDist([a.v.x, a.v.y], b.v.a, b.v.b) <= Math.max(a.v.r, 0.15) + b.v.w / 2;
    if (a.k === "p" && b.k === "v") return Math.hypot(a.v.x - b.v.x, a.v.y - b.v.y) <= Math.max(a.v.r, 0.15) + b.v.size / 2;
    if (a.k === "v" && b.k === "v") return Math.hypot(a.v.x - b.v.x, a.v.y - b.v.y) <= (a.v.size + b.v.size) / 2 - 1e-4;
    return false;
  };
  for (let i = 0; i < el.length; i++)
    for (let j = i + 1; j < el.length; j++) if (find(i) !== find(j) && touch(el[i]!, el[j]!)) parent[find(i)] = find(j);
  const sides: Set<number>[] = [];
  for (const end of [s.a, s.b]) {
    const stub: El = { k: "s", v: { a: end, b: end, w: s.w, layer: s.layer, net } };
    const set = new Set<number>();
    for (let i = 0; i < el.length; i++) if (touch(stub, el[i]!)) set.add(find(i));
    sides.push(set);
  }
  const [s0, s1] = sides as [Set<number>, Set<number>];
  if (!s0.size || !s1.size || [...s0].some((i) => s1.has(i))) return false; // dangling, or a loop
  for (const side of sides) {
    const got: string[] = [];
    el.forEach((e, i) => {
      if (e.k === "p" && side.has(find(i))) got.push(`${e.v.ref}.${e.v.pad}`);
    });
    if (got.length && got.every((g) => tp[g] !== undefined && s.w + 1e-6 >= tp[g]!.width)) return true;
  }
  return false;
}

type PwrClass = NetClassSpec;

function* undersize(
  segs: Segment[],
  classes: Record<string, PwrClass>,
  neck: number,
  padsByNet: Map<string, Pad[]>,
  vias: Via[],
  taps: Record<string, Record<string, TapPad>>,
  scaling: Acceptance["net_classes"]["neck_scaling"],
  currents: Record<string, number> | undefined,
  stack: readonly string[],
): Generator<[string, Segment]> {
  for (const [name, c] of Object.entries(classes)) {
    if (!name.startsWith("PWR_")) continue;
    for (const net of c.nets ?? []) {
      const amps = currents?.[net] ?? (c.current_max_A || 3.0);
      for (const s of segs.filter((x) => x.net === net)) {
        const inner = s.layer !== "F.Cu" && s.layer !== "B.Cu";
        const need = inner ? (c.inner_track_width ?? Infinity) || Infinity : c.track_width!;
        if (s.w + 1e-6 >= need) continue;
        // inner_neck_allowance_mm 0: strict inner necks, every under-width inner segment fails (no neck, no tap)
        if (inner && (c.inner_neck_allowance_mm === 0 || (c.inner_neck_allowance_mm as unknown) === false)) {
          yield [net, s];
          continue;
        }
        if (!(inner && (c.inner_track_width ?? null) === null)) {
          if (scaling) {
            const allow = Math.min(scaling.cap_mm, neck * (s.w / scaling.ref_width_mm) * (scaling.ref_current_A / amps));
            if ((padsByNet.get(net) ?? []).some((q) => dist(s.a, [q.x, q.y]) <= q.r + allow && dist(s.b, [q.x, q.y]) <= q.r + allow)) continue;
          } else if (length(s) <= neck && (nearPad(s.a, net, padsByNet, neck) || nearPad(s.b, net, padsByNet, neck))) continue;
          if (Object.keys(taps).length && tapBranch(s, net, segs, vias, padsByNet, taps, stack)) continue;
        }
        yield [net, s];
      }
    }
  }
}

/** Power-class segments below their class width that are neither a neck nor a tap (A7's failing copper). */
export function undersizeSegments(segs: Segment[], vias: Via[], pads: Pad[], acc: Acceptance, stack: readonly string[]): Array<[string, Segment]> {
  const padsByNet = new Map<string, Pad[]>();
  for (const p of pads) (padsByNet.get(p.net) ?? padsByNet.set(p.net, []).get(p.net)!).push(p);
  const nc = acc.net_classes;
  const neck = Number(/([\d.]+) mm/.exec(nc.neck_allowance)![1]);
  const taps: Record<string, Record<string, TapPad>> = {};
  for (const [n, d] of Object.entries(nc.tap_pads ?? {})) if (!n.startsWith("_") && typeof d === "object") taps[n] = d as Record<string, TapPad>;
  return [...undersize(segs, nc.classes as Record<string, PwrClass>, neck, padsByNet, vias, taps, nc.neck_scaling, nc.net_current_A, stack)];
}

export interface ProfileView {
  ground: string;
  planes: Set<string>;
  copper: string[];
  spans: Map<string, string>;
  valueExceptions: Set<string>;
}

/** The board's stack and exceptions as its acceptance declares them (a plain two-layer board when it says nothing). */
export function profile(acc: Acceptance): ProfileView {
  const sp = acc.stack_policy ?? ({} as Acceptance["stack_policy"]);
  const spans = new Map<string, string>();
  const declared = sp.via_spans ?? { through: ["F.Cu", "B.Cu"] };
  for (const [kind, pairs] of Object.entries(declared)) {
    const list: string[][] = pairs.length && typeof pairs[0] === "string" ? [pairs as string[]] : (pairs as string[][]);
    for (const pr of list) spans.set(pr.join("|"), kind);
  }
  return {
    ground: sp.ground_net ?? "GND",
    planes: new Set(planeLayerNames(sp.plane_layers)),
    copper: sp.copper_layers ?? ["F.Cu", "B.Cu"],
    spans,
    valueExceptions: new Set(acc.value_exceptions ?? []),
  };
}

const sum = (xs: Iterable<number>) => {
  let t = 0;
  for (const x of xs) t += x;
  return t;
};
const counter = <T>(items: Iterable<T>, key: (t: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};

export interface CheckOptions {
  /** Set false when the DRC run skipped schematic parity, so A3 says it was not measured. */
  parityChecked?: boolean;
  /** Board path for the record. */
  boardPath?: string;
}

/** A1-A9 on a parsed board. */
export function checkAcceptance(board: Board, req: Requirements, drc: DrcInput, opts: CheckOptions = {}): AcceptanceResult {
  const acc = req.acceptance;
  const prof = profile(acc);
  const stack = prof.copper;
  const fps = board.footprints;
  const segs = board.segments;
  const vias = board.vias;
  const padsByNet = new Map<string, Pad[]>();
  for (const p of board.pads) (padsByNet.get(p.net) ?? padsByNet.set(p.net, []).get(p.net)!).push(p);
  const R = {} as AcceptanceResults;

  const proxy = (v: DrcFinding) => v.rule === "track_width" && PWR_PROXY.test(v.description);
  const accepted = drc.violations.filter((v) => v.severity === "error" && courtyardException(v, acc));
  const errors = counter(
    drc.violations.filter((v) => v.severity === "error" && !proxy(v) && !courtyardException(v, acc)),
    (v) => v.rule,
  );
  const proxyN = drc.violations.filter((v) => v.severity === "error" && proxy(v)).length;
  R.A1_connectivity = { pass: drc.unconnected === 0, unconnected: drc.unconnected };
  R.A2_drc = { pass: !Object.keys(errors).length, errors, class_width_proxy_findings_judged_by_A7: proxyN };
  if (acc.courtyard_overlap_exceptions?.length) {
    // named pairs accepted in acceptance.json, with measured gaps; and the ones the board no longer has
    const seen = accepted.map((v) => [...courtyardException(v, acc)!.refs].sort());
    const key = (x: string[]) => JSON.stringify(x);
    const seenKeys = new Set(seen.map(key));
    R.A2_drc["accepted_courtyard_overlaps"] = seen;
    R.A2_drc["courtyard_exceptions_not_present"] = acc.courtyard_overlap_exceptions.map((e) => [...e.refs].sort()).filter((x) => !seenKeys.has(key(x)));
  }
  R.A3_parity = { pass: drc.parity === 0, items: drc.parity, ...(opts.parityChecked === false ? { checked: false } : {}) };

  // A4 circuit
  const norm = (pins: Record<string, string>) => JSON.stringify(Object.entries(pins).map(([k, v]) => [k, v.replaceAll("{slash}", "/")]).sort());
  const want = new Map(req.circuit.components.map((c) => [c.reference, c]));
  const missing = [...want.keys()].filter((r) => !fps.has(r)).sort();
  const pinDiff = [...want].filter(([r, c]) => fps.has(r) && norm(c.pins) !== norm(fps.get(r)!.pins)).map(([r]) => r).sort();
  const valueDiff = [...want]
    .filter(([r, c]) => fps.has(r) && !prof.valueExceptions.has(r) && (c.value ?? null) !== fps.get(r)!.value)
    .map(([r]) => r)
    .sort();
  R.A4_circuit = {
    pass: !(missing.length || pinDiff.length || valueDiff.length),
    missing,
    pin_net_diff: pinDiff.slice(0, 20),
    value_diff: valueDiff.slice(0, 20),
  };

  // A5 anchors
  const badAnchor: string[] = [];
  for (const an of req.mechanical.anchors) {
    const f = fps.get(an.reference);
    const rotDiff = f ? ((((f.rot - Number(an.rotation[0])) % 360) + 360) % 360) : 0;
    const ok =
      f &&
      Math.abs(f.x - Number(an.at[0])) < 1e-4 &&
      Math.abs(f.y - Number(an.at[1])) < 1e-4 &&
      Math.abs(rotDiff) < 1e-3 &&
      f.layer === an.layer;
    if (!ok) badAnchor.push(an.reference);
  }
  R.A5_anchors = { pass: !badAnchor.length, failed: badAnchor };

  // A6 stack
  const noTrack = new Set(acc.stack_policy.no_track_layers ?? [...prof.planes]);
  const planeTracks = counter(
    segs.filter((s) => noTrack.has(s.layer) && !(prof.planes.has(s.layer) && s.net === prof.ground)),
    (s) => s.net,
  );
  const badSpan = counter(
    vias.filter((v) => prof.spans.get(viaSpan(v, stack).join("|")) !== v.kind),
    (v) => {
      const [a, b] = viaSpan(v, stack);
      return `${v.kind}:${a}-${b}`;
    },
  );
  const unfilled = vias.filter((v) => v.kind !== "through" && !(v.fill && v.cap)).length;
  const signalMicro = vias.filter((v) => v.kind === "micro" && v.net !== prof.ground).length;
  R.A6_stack = {
    pass: !Object.keys(planeTracks).length && !Object.keys(badSpan).length && !unfilled,
    non_gnd_plane_track_segments: sum(Object.values(planeTracks)),
    nets_on_planes: Object.keys(planeTracks).length,
    illegal_via_spans: badSpan,
    unfilled_or_uncapped_laser_buried: unfilled,
    non_gnd_microvias_review: signalMicro,
  };

  // A7 widths
  const classes = acc.net_classes.classes;
  const neck = Number(/([\d.]+) mm/.exec(acc.net_classes.neck_allowance)![1]);
  const widthFail = new Map<string, number>();
  const widthAt: Record<string, unknown[]> = {};
  const taps: Record<string, Record<string, TapPad>> = {};
  for (const [n, d] of Object.entries(acc.net_classes.tap_pads ?? {})) if (!n.startsWith("_") && typeof d === "object") taps[n] = d;
  for (const [net, s] of undersize(segs, classes, neck, padsByNet, vias, taps, acc.net_classes.neck_scaling, acc.net_classes.net_current_A, stack)) {
    widthFail.set(net, (widthFail.get(net) ?? 0) + length(s));
    const at = (widthAt[net] ??= []);
    if (at.length < 6) {
      let near: Pad | undefined;
      let bestD = Infinity;
      for (const q of padsByNet.get(net) ?? []) {
        const d = (q.x - s.a[0]) ** 2 + (q.y - s.a[1]) ** 2;
        if (d < bestD) {
          bestD = d;
          near = q;
        }
      }
      at.push({ xy: [pyRound(s.a[0], 2), pyRound(s.a[1], 2)], layer: s.layer, w: s.w, mm: pyRound(length(s), 2), near_pad: near ? `${near.ref}.${near.pad}` : null });
    }
  }
  R.A7_widths = {
    pass: widthFail.size === 0,
    nets_failing: widthFail.size,
    undersize_length_mm: Object.fromEntries([...widthFail].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pyRound(v, 2)])),
    undersize_at: widthAt,
  };

  // A8 pairs
  const pairFail: Record<string, Record<string, unknown>> = {};
  const coupling: Record<string, Record<string, unknown> & { p_mm: number; n_mm: number; length_difference_mm: number; skew_limit_mm: number; uncoupled: boolean; class: string }> = {};
  const segsByNet = new Map<string, Segment[]>();
  for (const s of segs) (segsByNet.get(s.net) ?? segsByNet.set(s.net, []).get(s.net)!).push(s);
  for (const [name, c] of Object.entries(classes)) {
    if (!c.pairs?.length) continue;
    const esc = new Set(c.escape_layers ?? stack);
    const reach = (c.diff_pair_width! + c.diff_pair_gap!) * 1.25;
    for (const [pNet, nNet] of c.pairs) {
      const ps = segsByNet.get(pNet) ?? [];
      const ns = segsByNet.get(nNet) ?? [];
      const total = sum(ps.map(length));
      let got = 0;
      const matesByLayer = new Map<string, Segment[]>();
      for (const t of ns) (matesByLayer.get(t.layer) ?? matesByLayer.set(t.layer, []).get(t.layer)!).push(t);
      for (const s of ps) {
        const k = Math.max(1, Math.trunc(length(s) / 0.1));
        const mates = matesByLayer.get(s.layer) ?? [];
        for (let i = 0; i < k; i++) {
          const u = (i + 0.5) / k;
          const q: Pt = [s.a[0] + u * (s.b[0] - s.a[0]), s.a[1] + u * (s.b[1] - s.a[1])];
          if (mates.some((t) => segDist(q, t.a, t.b) <= reach)) got += length(s) / k;
        }
      }
      const nTotal = sum(ns.map(length));
      const cs = total ? pyRound(got / total, 2) : 0.0;
      const cp = {
        class: name,
        p_mm: pyRound(total, 2),
        n_mm: pyRound(nTotal, 2),
        coupled_share: cs,
        length_difference_mm: pyRound(Math.abs(total - nTotal), 2),
        skew_limit_mm: c.intra_pair_skew_max_mm!,
        uncoupled: false,
      };
      cp.uncoupled = Math.max(total, nTotal) >= (c.coupling_applies_from_mm ?? 0) && cs < (c.min_coupled_share ?? 0);
      coupling[`${pNet} / ${nNet}`] = cp;
      for (const [net, ss] of [[pNet, ps], [nNet, ns]] as const) {
        const off = sum(ss.filter((s) => !c.layers!.includes(s.layer) && esc.has(s.layer)).map(length));
        const stray = sum(ss.filter((s) => !c.layers!.includes(s.layer) && !esc.has(s.layer)).map(length));
        const allow = c.escape_allowance_mm! * Math.max(1, (padsByNet.get(net) ?? []).length);
        const dpw = c.diff_pair_width!;
        const ratio = c.neck_min_width_ratio ?? 1.0;
        const neckMax = c.neck_max_mm ?? 0.0;
        const necks = new Set(ss.filter((s) => s.w < dpw - 1e-3 && s.w >= ratio * dpw - 1e-4));
        const neckMm = sum([...necks].map(length));
        const wrongW = ss.filter((s) => Math.abs(s.w - dpw) > 1e-3 && !(necks.has(s) && neckMm <= neckMax + 1e-6)).length;
        if (off > allow || stray > (c.inner_stray_mm ?? 0) || wrongW || cp.uncoupled)
          pairFail[net] = { class: name, off_layer_mm: pyRound(off, 2), allowed_mm: allow, inner_stray_mm: pyRound(stray, 2), wrong_width_segments: wrongW, uncoupled: cp.uncoupled };
      }
    }
  }
  // a pair with no copper on a board whose pair pads are routed elsewhere cannot pass by measuring nothing
  for (const [k, v] of Object.entries(coupling)) {
    if (v.p_mm === 0 && v.n_mm === 0 && R.A1_connectivity.pass)
      for (const net of k.split(" / ")) if ((padsByNet.get(net) ?? []).length > 1 && !(net in pairFail)) pairFail[net] = { class: v.class, no_copper_found: true };
  }
  const todo = Object.entries(coupling)
    .filter(([k, v]) => k.split(" / ").some((n) => n in pairFail) || v.length_difference_mm > v.skew_limit_mm)
    .map(([k]) => k.split(" / "));
  R.A8_pairs = {
    pass: !Object.keys(pairFail).length,
    nets_failing: Object.keys(pairFail).length,
    detail: pairFail,
    pairs_to_reroute: todo,
    coupling,
    pairs_uncoupled: Object.values(coupling).filter((v) => v.uncoupled).length,
    pairs_over_skew_limit: Object.values(coupling).filter((v) => v.length_difference_mm > v.skew_limit_mm).length,
    note:
      "pass covers width, layers and coupling (acceptance.json A8). Length difference is reported and feeds pairs_to_reroute, " +
      "not the pass; gap and skew detail with a pair measurement tool.",
  };

  // A9 heights
  const h = acc.heights ?? ({} as Acceptance["heights"]);
  const limit = { F: h.F_max_mm, B: h.B_max_mm };
  const limited = [limit.F, limit.B].every((v) => v !== undefined && v !== null && v > 0 && v < 1e6);
  if (!limited) R.A9_heights = { pass: true, applies: false, note: "no height limits set for this board" };
  else {
    const screens = new Map(req.heights.entries.map((e) => [e.ref, e.height_above_surface_mm ?? null]));
    const over: Record<string, unknown> = {};
    const unscreened: string[] = [];
    for (const [ref, f] of fps) {
      if (ref.startsWith("FIT_")) continue;
      const ht = screens.get(ref);
      const side = f.layer[0] as "F" | "B";
      if (ht === undefined || ht === null) unscreened.push(ref);
      else if (ht > limit[side] + 1e-6) over[ref] = { side, height_mm: pyRound(ht, 3), limit_mm: limit[side] };
    }
    R.A9_heights = { pass: !Object.keys(over).length, over_limit: over, unscreened: unscreened.sort() };
  }

  const summary = Object.fromEntries(CHECK_KEYS.map((k) => [k, R[k].pass])) as Record<CheckKey, boolean>;
  return { board: opts.boardPath ?? "", summary, results: R, names: CHECK_NAMES };
}

/** One headline figure per check, for the history and the before/after comparison. */
export function figures(r: AcceptanceResult): Record<CheckCode, number> {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const res = r.results;
  return {
    A1: n(res.A1_connectivity.unconnected),
    A2: sum(Object.values((res.A2_drc["errors"] ?? {}) as Record<string, number>)),
    A3: n(res.A3_parity["items"]),
    A4: len(res.A4_circuit["missing"]) + len(res.A4_circuit["pin_net_diff"]) + len(res.A4_circuit["value_diff"]),
    A5: len(res.A5_anchors["failed"]),
    A6: n(res.A6_stack["non_gnd_plane_track_segments"]) + Object.keys((res.A6_stack["illegal_via_spans"] ?? {}) as object).length + n(res.A6_stack["unfilled_or_uncapped_laser_buried"]),
    A7: n(res.A7_widths["nets_failing"]),
    A8: n(res.A8_pairs["nets_failing"]),
    A9: Object.keys((res.A9_heights["over_limit"] ?? {}) as object).length,
  };
}

export type AcceptCode = CheckCode;

/** The protocol's per-check result (`AcceptResult` in @fabdesk/protocol): status, the figures the verdict rests on, evidence lines. */
export interface AcceptResult {
  code: AcceptCode;
  status: "pass" | "fail" | "na" | "error";
  figures: Record<string, number | string | boolean>;
  evidence: string[];
}

const top = (o: unknown, n = 6): string[] => (o && typeof o === "object" ? Object.keys(o as object).slice(0, n) : []);

/** The nine verdicts as `AcceptResult[]`: `na` where a check does not apply or was not measured. */
export function toAcceptResults(r: AcceptanceResult): AcceptResult[] {
  const f = figures(r);
  const res = r.results;
  const list = (label: string, xs: unknown): string[] => (Array.isArray(xs) && xs.length ? [`${label}: ${xs.slice(0, 8).join(", ")}${xs.length > 8 ? ", ..." : ""}`] : []);
  const one = (code: AcceptCode, key: CheckKey, figs: Record<string, number | string | boolean>, evidence: string[], na = false): AcceptResult => ({
    code,
    status: na ? "na" : res[key].pass ? "pass" : "fail",
    figures: figs,
    evidence: res[key].pass ? [] : evidence,
  });
  const a2 = (res.A2_drc["errors"] ?? {}) as Record<string, number>;
  const a6 = res.A6_stack;
  const a7 = res.A7_widths;
  const a8 = res.A8_pairs;
  return [
    one("A1", "A1_connectivity", { unconnected: f.A1 }, [`${f.A1} unconnected items (KiCad DRC, refilled zones)`]),
    one("A2", "A2_drc", { errors: f.A2, class_width_proxy_findings: Number(res.A2_drc["class_width_proxy_findings_judged_by_A7"] ?? 0), ...(Array.isArray(res.A2_drc["accepted_courtyard_overlaps"]) ? { accepted_courtyard_overlaps: (res.A2_drc["accepted_courtyard_overlaps"] as unknown[]).length } : {}) }, Object.entries(a2).map(([k, n]) => `${n} x ${k}`)),
    one("A3", "A3_parity", { items: f.A3, measured: res.A3_parity["checked"] !== false }, [`${f.A3} schematic/PCB parity items`], res.A3_parity["checked"] === false),
    one("A4", "A4_circuit", { missing: (res.A4_circuit["missing"] as unknown[]).length, pin_net_diff: (res.A4_circuit["pin_net_diff"] as unknown[]).length, value_diff: (res.A4_circuit["value_diff"] as unknown[]).length },
      [...list("missing parts", res.A4_circuit["missing"]), ...list("pin/net differences", res.A4_circuit["pin_net_diff"]), ...list("value differences", res.A4_circuit["value_diff"])]),
    one("A5", "A5_anchors", { failed: f.A5 }, list("anchor moved", res.A5_anchors["failed"])),
    one("A6", "A6_stack", { plane_track_segments: Number(a6["non_gnd_plane_track_segments"]), nets_on_planes: Number(a6["nets_on_planes"]), unfilled_vias: Number(a6["unfilled_or_uncapped_laser_buried"]), microvias_to_review: Number(a6["non_gnd_microvias_review"]) },
      [...(Number(a6["nets_on_planes"]) ? [`${a6["non_gnd_plane_track_segments"]} track segment(s) of ${a6["nets_on_planes"]} net(s) on plane layers`] : []), ...Object.entries((a6["illegal_via_spans"] ?? {}) as Record<string, number>).map(([k, n]) => `${n} via(s) ${k} not a declared span`)]),
    one("A7", "A7_widths", { nets_failing: Number(a7["nets_failing"]) }, Object.entries((a7["undersize_length_mm"] ?? {}) as Record<string, number>).slice(0, 8).map(([n, mm]) => `${n}: ${mm} mm below class width`)),
    one("A8", "A8_pairs", { nets_failing: Number(a8["nets_failing"]), pairs_uncoupled: Number(a8["pairs_uncoupled"]), pairs_over_skew_limit: Number(a8["pairs_over_skew_limit"]), pairs: Object.keys((a8["coupling"] ?? {}) as object).length },
      top(a8["detail"], 8).map((n) => `${n}: ${JSON.stringify((a8["detail"] as Record<string, unknown>)[n])}`), Object.keys((a8["coupling"] ?? {}) as object).length === 0),
    one("A9", "A9_heights", { over_limit: f.A9, unscreened: Array.isArray(res.A9_heights["unscreened"]) ? (res.A9_heights["unscreened"] as unknown[]).length : 0 },
      top(res.A9_heights["over_limit"], 8).map((n) => `${n} over the height limit`), res.A9_heights["applies"] === false),
  ];
}
