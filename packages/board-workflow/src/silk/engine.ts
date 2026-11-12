/**
 * silk: reference labels on the silkscreen: check them, place them. The agent decides the rules (a plan); this computes
 * the geometry. Ported from the toolkit's `flow/silk.py` (checker, solver) over the model in `model.ts`.
 *
 * Plan (all optional; defaults below, with reasons):
 *   {"heights": [1.0, 0.8], "stroke": 0.16, "min_height": 0.8, "min_stroke": 0.15,
 *    "clear": {"copper": 0.15, "silk": 0.12, "label": 0.15, "edge": 0.3, "body": 0.1},
 *    "labels": "all" | "visible",            all: every part with a netted pad gets a label if one fits
 *    "skip": ["FIT_*"], "keep": ["C18_U1"], "pin": {"C18_U1": {"at": [x, y], "angle": 0, "height": 1.0}},
 *    "hide": ["A74_TP*"], "inside_ok": ["A74_J1"], "max_gap": 1.5}
 */
import { Grid, grow, inside, overlap, rectDist, rectPolyHit, segRect, type Poly, type Pt, type Rect } from "./geometry";
import type { SilkModel, Part, FreeText } from "./model";

export interface Plan {
  heights: number[];
  stroke: number;
  min_height: number;
  min_stroke: number;
  clear: Record<"copper" | "silk" | "label" | "edge" | "body" | "courtyard", number | null>;
  judge: Record<"copper" | "silk" | "label" | "edge" | "body" | "courtyard", number | null>;
  courtyard_penalty: number;
  labels: "all" | "visible";
  mode: "fix" | "all";
  skip: string[];
  keep: string[];
  pin: Record<string, { at: [number, number]; angle?: number; height?: number }>;
  hide: string[];
  inside_ok: string[];
  max_gap: number;
  texts: "keep" | "move";
  detached_mm: number;
  text_size: "fix" | "keep";
  ambiguous_ok: boolean;
  spots: number;
  spot_cost: number;
  label?: "ref" | "short";
}

export const DEFAULTS: Plan = {
  // JLC silkscreen: min line width 0.153 mm, text height >= 0.8 mm reads under a loupe; 1.0 mm is comfortable.
  heights: [1.0, 0.8],
  stroke: 0.16,
  min_height: 0.8,
  min_stroke: 0.15,
  // copper: JLC clips silk off pads (0.15 mm); a label crossing a pad is cut and unreadable, so keep it clear.
  // silk/label: strokes closer than ~0.12 mm merge in print. edge: board routing tolerance + clipping.
  // body: a label inside a courtyard is under the part once assembled.
  clear: { copper: 0.15, silk: 0.12, label: 0.15, edge: 0.3, body: 0.1, courtyard: 0.0 },
  // judge: what counts as a defect on an existing board (real overlap, not the solver's margins). Text is judged by its
  // box: two labels whose boxes touch read as one even when the strokes do not (KiCad DRC checks strokes only).
  judge: { copper: 0.05, silk: 0.0, label: 0.0, edge: 0.15, body: 0.0, courtyard: null },
  courtyard_penalty: 2.0, // solver: a label inside another part's courtyard is legal (outside its body) but crowded
  labels: "all",
  mode: "fix", // fix: keep labels that pass, place the rest (small diff after an ECO); all: re-place every label
  skip: [],
  keep: [],
  pin: {},
  hide: [],
  inside_ok: [],
  max_gap: 1.5, // farthest a label may sit from its own courtyard (mm); further reads as another part's
  texts: "keep", // free board texts: keep (fixed; judged) | move (a text naming a part is re-placed next to it)
  detached_mm: 3.0, // a free text naming a part further than this reads as stale (left behind by a re-place)
  text_size: "fix", // a moved free text below min height/stroke is brought up to them (keep: original size)
  ambiguous_ok: false, // a label nearer another part misleads at the bench: worse than none
  spots: 400, // feasible spots kept per label for the greedy pass and its repair
  spot_cost: 6.0, // solver: weight of taking the last spots of labels still to place
};

export function planOf(user?: Partial<Plan> | string | null): Plan {
  const p = JSON.parse(JSON.stringify(DEFAULTS)) as Plan;
  if (!user) return p;
  const u = (typeof user === "string" ? JSON.parse(user) : user) as Record<string, unknown>;
  for (const [k, v] of Object.entries(u)) {
    const cur = (p as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) Object.assign(cur, v);
    else (p as unknown as Record<string, unknown>)[k] = v;
  }
  return p;
}

const globRx = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");
export const matches = (ref: string, pats: readonly string[]) => pats.some((q) => globRx(q).test(ref));

type Kind = "copper" | "silk" | "label" | "body" | "courtyard" | "spot";
const ALIAS: Record<string, string> = { copper: "over-copper", silk: "over-silk", label: "over-label", body: "under-part", edge: "edge" };

type ItemInfo = Part | (SilkModel["extra"][string] & { owner: string });

/** Obstacles indexed per side. */
export class World {
  g = { F: new Grid<Kind>(), B: new Grid<Kind>() };
  labels = new Map<string, { side: "F" | "B"; idx: number; rect: Rect }>();
  outer: Poly[];
  inner: Poly[];
  edges: Array<[Pt, Pt]>;
  c: Record<string, number | null>;
  constructor(readonly m: SilkModel, readonly plan: Plan, clear?: Record<string, number | null>) {
    this.c = { ...(clear ?? plan.clear) };
    for (const s of ["F", "B"] as const) {
      for (const [owner, q] of m.copper[s]) this.g[s].add("copper", owner, q);
      for (const [owner, q] of m.silk[s]) this.g[s].add("silk", owner, q);
      for (const [ref, p] of Object.entries(m.parts)) {
        if (p.side !== s) continue;
        const [x0, y0, x1, y1] = p.body;
        this.g[s].add("body", ref, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        if (this.c["courtyard"] !== null && this.c["courtyard"] !== undefined) for (const q of p.courtyard) this.g[s].add("courtyard", ref, q);
      }
    }
    this.outer = m.outline;
    this.inner = m.holes_outline;
    this.edges = [...this.outer, ...this.inner].flatMap((q) => q.map((_, i) => [q[i]!, q[(i + 1) % q.length]!] as [Pt, Pt]));
  }

  item(ref: string): ItemInfo {
    return (this.m.parts[ref] ?? this.m.extra[ref]) as ItemInfo;
  }

  /** What a label rect for `ref` collides with: (kind, owner) pairs. stopHard: return at the first hit that is not a courtyard. */
  hits(side: "F" | "B", rect: Rect, ref: string, skipLabels: readonly string[] = [], insideOk = false, stopHard = false): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const c = this.c;
    const own = ref in this.m.parts || ref in this.m.extra ? ((this.item(ref) as { owner?: string }).owner ?? ref) : ref;
    const big = grow(rect, Math.max(...Object.values(c).filter((v): v is number => v !== null)));
    for (const [, it] of this.g[side].near(big)) {
      if (!it) continue;
      const { kind, poly, bb } = it;
      const owner = it.owner as string;
      if (kind === "label" && skipLabels.includes(owner)) continue;
      if ((kind === "body" || kind === "courtyard") && owner === own && insideOk) continue;
      if (kind === "silk" && owner === ref && ref.startsWith("text:")) continue; // a board text's own strokes
      const cl = c[kind];
      if (kind === "silk" && owner === ref + ":value") continue;
      if (cl === null || cl === undefined) continue;
      if (rectPolyHit(grow(rect, cl), poly, bb)) {
        out.push([kind, owner]);
        if (stopHard && kind !== "courtyard") return out;
      }
    }
    const e = grow(rect, c["edge"] ?? 0);
    const corners: Pt[] = [[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]]];
    if (!this.outer.some((q) => corners.every(([x, y]) => inside(x, y, q))) || this.edges.some(([a, b]) => segRect(a, b, e))) out.push(["edge", "outline"]);
    return out;
  }

  addLabel(ref: string, side: "F" | "B", rect: Rect): void {
    const poly: Poly = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
    this.labels.set(ref, { side, idx: this.g[side].add("label", ref, poly, rect), rect });
  }

  dropLabel(ref: string): void {
    const l = this.labels.get(ref)!;
    this.labels.delete(ref);
    this.g[l.side].remove(l.idx);
  }

  /** A label belongs, to the eye, to the nearest part. [other, why] when another part is nearer than `ref` from the edge and the centre. */
  whose(side: "F" | "B", rect: Rect, ref: string, tol = 0): [string, string] | null {
    const p = this.item(ref);
    const own = p.cbox;
    const oref = (p as { owner?: string }).owner ?? ref;
    const cx = (rect[0] + rect[2]) / 2;
    const cy = (rect[1] + rect[3]) / 2;
    const de = rectDist(rect, own);
    const dc = rectDist([cx, cy, cx, cy], own);
    for (const [, it] of this.g[side].near(grow(rect, dc + 0.01))) {
      if (!it || it.kind !== "body" || it.owner === oref) continue;
      const ob = this.m.parts[it.owner as string]!.cbox;
      const oe = rectDist(rect, ob);
      const oc = rectDist([cx, cy, cx, cy], ob);
      if (oe + 0.05 < de + tol && oc + 0.05 < dc + tol) return [it.owner as string, `nearer ${it.owner} (${oe.toFixed(1)}/${oc.toFixed(1)} vs ${de.toFixed(1)}/${dc.toFixed(1)} mm edge/centre)`];
    }
    return null;
  }
}

/**
 * The solver rejects a spot that sits within 1 um of the ambiguity threshold (its candidate gaps land exactly on it, and
 * a rounding in the written coordinates would flip the check's verdict). The check itself stays strict.
 */
const SOLVER_TOL = 1e-3;

export function wanted(ref: string, p: Part, plan: Plan): boolean {
  if (matches(ref, plan.skip) || matches(ref, plan.hide)) return false;
  if (matches(ref, plan.keep) || ref in plan.pin) return true;
  if (plan.labels === "visible") return p.label.visible && p.label.on_silk;
  return p.netted && !p.attrs.board_only;
}

const REF_TOKEN = /^([A-Z]+[0-9]+[A-Z]?)(?:\b|_|$)/;

/** The part a free text names first ('J106 SWD' -> J106), if that part exists on the board. */
export function textTarget(tx: FreeText | { text: string }, m: SilkModel): string | null {
  const s = tx.text.trim();
  let mm = REF_TOKEN.exec(s);
  if (mm && mm[1]! in m.parts) return mm[1]!;
  mm = /^(\S+)/.exec(s);
  return mm && mm[1]! in m.parts ? mm[1]! : null;
}

// ------------------------------------------------------------------ check

export interface Issue {
  kind: string;
  with: string[];
}
export interface Verdict {
  labels: number;
  wanted: number;
  clean: number;
  bad: number;
  counts: Record<string, number>;
  rows: Array<{ ref: string; side: string; issues: Issue[] }>;
  texts: number;
  texts_bad: number;
  text_counts: Record<string, number>;
  text_rows: Array<{ text: string; uuid: string; side: string; target: string | null; issues: Issue[] }>;
}

const bbox = (q: Poly): Rect => [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];

export function judge(m: SilkModel, plan: Plan): Verdict {
  const w = new World(m, plan, plan.judge);
  const rows: Verdict["rows"] = [];
  const counts: Record<string, number> = {};
  const visible = Object.entries(m.parts).filter(([, p]) => p.label.visible && p.label.on_silk);
  const visibleSet = new Set(visible.map(([r]) => r));
  for (const [ref, p] of visible) w.addLabel(ref, p.side, p.label.box);
  const outlineBad: Record<string, Array<[string, string[]]>> = {}; // footprint silk (not labels) over copper / other silk
  for (const s of ["F", "B"] as const)
    for (const [owner, q] of m.silk[s]) {
      if (owner === "board" || owner.includes(":")) continue;
      const bb = bbox(q);
      for (const [, it] of w.g[s].near(bb)) {
        if (!it || (it.kind !== "copper" && it.kind !== "silk") || (it.owner as string).split(":")[0] === owner) continue;
        if (q.some(([x, y]) => inside(x, y, it.poly)) || it.poly.some(([x, y]) => inside(x, y, q))) {
          const k = it.kind === "copper" ? "outline-over-copper" : "outline-overlap";
          const list = (outlineBad[owner] ??= []);
          if (!list.some((e) => e[0] === k && e[1].includes(it.owner as string))) list.push([k, [it.owner as string]]);
        }
      }
    }
  const textNamed: Record<string, string> = {};
  for (const tx of m.texts) {
    const tg = textTarget(tx, m);
    if (tg && rectDist(tx.box, m.parts[tg]!.cbox) <= plan.max_gap + 0.05) textNamed[tg] = tx.text;
  }
  for (const [ref, p] of Object.entries(m.parts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const lab = p.label;
    const issues: Array<[string, string[]]> = [];
    if (visibleSet.has(ref)) {
      const side = lab.layer.startsWith("B") ? "B" : "F";
      const rect = lab.box;
      const hs = w.hits(side, rect, ref, [ref], matches(ref, plan.inside_ok));
      const kinds = new Map<string, Set<string>>();
      for (const [k, o] of hs) (kinds.get(k) ?? kinds.set(k, new Set()).get(k)!).add(o);
      for (const [k, own] of kinds) issues.push([ALIAS[k]!, [...own].sort().slice(0, 4)]);
      if (lab.height + 1e-6 < plan.min_height || lab.stroke + 1e-6 < plan.min_stroke) issues.push(["small", [`${lab.height.toFixed(2)}/${lab.stroke.toFixed(2)} mm`]]);
      if (Math.round(lab.angle) % 90) issues.push(["orientation", [`${lab.angle.toFixed(0)} deg`]]);
      if (side !== p.side) issues.push(["wrong-side", [lab.layer]]);
      const own = rectDist(rect, p.cbox);
      const amb = w.whose(p.side, rect, ref);
      if (own > plan.max_gap + 0.05) issues.push(["far", [`${own.toFixed(1)} mm`]]);
      else if (amb) issues.push(["ambiguous", [amb[1]]]);
    } else if (wanted(ref, p, plan) && !(ref in textNamed)) issues.push(["unlabelled", []]);
    for (const e of outlineBad[ref] ?? []) issues.push(e);
    if (visibleSet.has(ref) && ref in textNamed) issues.push(["duplicate", [`free text '${textNamed[ref]}'`]]);
    for (const [k] of issues) counts[k] = (counts[k] ?? 0) + 1;
    if (issues.length) rows.push({ ref, side: p.side, issues: issues.map(([k, o]) => ({ kind: k, with: o })) });
  }
  const labelled = visible.length;
  const bad = rows.filter((r) => r.issues.some((i) => !["unlabelled", "outline-over-copper", "outline-overlap"].includes(i.kind))).length;
  const want = Object.entries(m.parts).filter(([r, p]) => wanted(r, p, plan)).length;
  const trows: Verdict["text_rows"] = [];
  const tcounts: Record<string, number> = {};
  for (const tx of m.texts) {
    const issues: Array<[string, string[]]> = [];
    const hs = w.hits(tx.side, tx.box, tx.owner);
    const kinds = new Map<string, Set<string>>();
    for (const [k, o] of hs) (kinds.get(k) ?? kinds.set(k, new Set()).get(k)!).add(o);
    for (const [k, own] of kinds) issues.push([ALIAS[k]!, [...own].sort().slice(0, 4)]);
    if (tx.height + 1e-6 < plan.min_height || tx.stroke + 1e-6 < plan.min_stroke) issues.push(["small", [`${tx.height.toFixed(2)}/${tx.stroke.toFixed(2)} mm`]]);
    const tgt = textTarget(tx, m);
    if (tgt && rectDist(tx.box, m.parts[tgt]!.cbox) > plan.detached_mm) issues.push(["detached", [`${tgt} ${rectDist(tx.box, m.parts[tgt]!.cbox).toFixed(1)} mm away`]]);
    for (const [k] of issues) tcounts[k] = (tcounts[k] ?? 0) + 1;
    if (issues.length) trows.push({ text: tx.text, uuid: tx.uuid, side: tx.side, target: tgt, issues: issues.map(([k, o]) => ({ kind: k, with: o })) });
  }
  return { labels: labelled, wanted: want, clean: labelled - bad, bad, counts, rows, texts: m.texts.length, texts_bad: trows.length, text_counts: tcounts, text_rows: trows };
}

// ------------------------------------------------------------------ place

const SIDES = ["top", "bottom", "left", "right"] as const;
type Cand = [number, Rect, number];

function ring(box: Rect, w_: number, h_: number, plan: Plan, extra: number): Cand[] {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const wide = x1 - x0 >= y1 - y0;
  const gaps = [plan.clear.body! + 0.02, 0.25, 0.45, 0.7, 1.0, plan.max_gap];
  const out: Cand[] = [];
  for (const ang of [0, 90]) {
    const [w, h] = ang === 0 ? [w_, h_] : [h_, w_];
    let apen = (ang === 0) === wide ? 0.0 : 0.6;
    if (ang === 90) apen += 0.4; // horizontal reads first
    SIDES.forEach((sname, si) => {
      const spen = [0.0, 0.15, 0.35, 0.45][si]!;
      for (const g of gaps) {
        if (g > plan.max_gap + 1e-9) continue;
        if (sname === "top" || sname === "bottom") {
          const yc = sname === "top" ? y0 - g - h / 2 : y1 + g + h / 2;
          const span = (x1 - x0) / 2 + w / 2 - 0.2;
          const steps = [0.0];
          for (let k = 1; k < 40; k++) for (const s of [1, -1]) if (k * 0.2 <= span) steps.push(s * k * 0.2);
          for (const d of steps) out.push([extra + apen + spen + g * 3 + Math.abs(d) * 1.2, [cx + d - w / 2, yc - h / 2, cx + d + w / 2, yc + h / 2], ang]);
        } else {
          const xc = sname === "left" ? x0 - g - w / 2 : x1 + g + w / 2;
          const span = (y1 - y0) / 2 + h / 2 - 0.2;
          const steps = [0.0];
          for (let k = 1; k < 40; k++) for (const s of [1, -1]) if (k * 0.2 <= span) steps.push(s * k * 0.2);
          for (const d of steps) out.push([extra + apen + spen + g * 3 + Math.abs(d) * 1.2, [xc - w / 2, cy + d - h / 2, xc + w / 2, cy + d + h / 2], ang]);
        }
      }
    });
  }
  return out;
}

/** Label rects around the part, best first. Ring 1 hugs the courtyard; ring 2 hugs the body for crowded spots. */
export function candidates(p: { cbox: Rect; body: Rect }, w_: number, h_: number, plan: Plan): Cand[] {
  const out = [...ring(p.cbox, w_, h_, plan, 0.0), ...ring(p.body, w_, h_, plan, 1.0)];
  return out.sort((a, b) => a[0] - b[0]);
}

const PREFIX = /^[A-Z]+\d+_(?=[A-Z])/;
/** The printed string. 'short' drops a block prefix (C18_C4 -> C4), a what-if only. */
export function labelText(ref: string, plan: Plan): string {
  return plan.label === "short" ? ref.replace(PREFIX, "") : ref;
}

/** Existing labels that pass the judge: kept as they are in fix mode (a small diff after an ECO). */
export function cleanLabels(m: SilkModel, plan: Plan, verdict: Verdict): Record<string, Rect> {
  const bad = new Set(verdict.rows.filter((r) => r.issues.some((i) => !["unlabelled", "outline-over-copper", "outline-overlap"].includes(i.kind))).map((r) => r.ref));
  const out: Record<string, Rect> = {};
  for (const [r, p] of Object.entries(m.parts)) if (p.label.visible && p.label.on_silk && !bad.has(r) && wanted(r, p, plan) && !(r in plan.pin)) out[r] = p.label.box;
  return out;
}

export type Placed = [number, Rect, number, number]; // score, rect, angle, height
export interface SolveResult {
  placed: Record<string, Placed>;
  why: Record<string, { reason: string; blocked_by_of_60_best: Record<string, number> }>;
  todo: string[];
}

export function solve(m: SilkModel, plan: Plan, fixed: Record<string, Rect> = {}, log: (s: string) => void = () => {}): SolveResult {
  const t0 = Date.now();
  if (plan.texts === "move")
    for (const tx of m.texts) {
      const tgt = textTarget(tx, m);
      if (tgt) {
        const q = m.parts[tgt]!;
        m.extra[tx.owner] = { side: tx.side, cbox: q.cbox, body: q.body, owner: tgt, label_text: tx.text, heights: [plan.text_size === "fix" ? Math.max(tx.height, plan.min_height) : tx.height], stroke: plan.text_size === "fix" ? Math.max(tx.stroke, plan.stroke) : tx.stroke, uuid: tx.uuid, is_text: true };
      }
    }
  const w = new World(m, plan);
  const oldStrokes = new Map<string, Array<["F" | "B", { kind: Kind; owner: unknown; poly: Poly; bb: Rect }]>>(); // a moving text's old strokes are not an obstacle...
  for (const [s, g] of Object.entries(w.g) as Array<["F" | "B", Grid<Kind>]>)
    g.items.forEach((it, i) => {
      if (it && it.kind === "silk" && (it.owner as string) in m.extra) {
        (oldStrokes.get(it.owner as string) ?? oldStrokes.set(it.owner as string, []).get(it.owner as string)!).push([s, it]);
        g.remove(i);
      }
    });
  const parts = m.parts;
  const P = (r: string): ItemInfo & { heights?: number[]; label_text?: string; stroke?: number; is_text?: boolean } => (parts[r] ?? m.extra[r]) as never;
  const tb = m.textBox;
  for (const [ref, rect] of Object.entries(fixed)) w.addLabel(ref, P(ref).side, rect);
  const named = new Set(Object.values(m.extra).map((x) => x.owner)); // a free text naming a part is that part's label
  const todo = [...Object.entries(parts).filter(([r, p]) => wanted(r, p, plan) && !(r in fixed) && !named.has(r)).map(([r]) => r), ...Object.keys(m.extra)];
  const cands = new Map<string, Array<[number, Rect, number, number]>>();
  for (const ref of todo) {
    const p = P(ref);
    const lst: Array<[number, Rect, number, number]> = [];
    (p.heights ?? plan.heights).forEach((hgt, li) => {
      const [tw, th] = tb(p.label_text ?? labelText(ref, plan), hgt, p.stroke ?? plan.stroke);
      for (const [sc, rect, ang] of candidates(p, tw, th, plan)) lst.push([sc + li * 4.0, rect, ang, hgt]);
    });
    lst.sort((a, b) => a[0] - b[0]);
    cands.set(ref, lst);
  }
  // static feasibility (no labels yet) orders the greedy pass: fewest options first
  const free = new Map<string, Array<[number, Rect, number, number]>>();
  for (const ref of todo) {
    const p = P(ref);
    const io = matches(ref, plan.inside_ok);
    const ok: Array<[number, Rect, number, number]> = [];
    for (const c of cands.get(ref)!) {
      if (ok.length >= plan.spots) break; // candidates are scored best first; enough to choose from
      const hs = w.hits(p.side, c[1], ref, [], io, true);
      if (hs.some(([k]) => k !== "courtyard")) continue;
      if (!plan.ambiguous_ok && w.whose(p.side, c[1], ref, SOLVER_TOL)) continue; // it would read as the neighbour's label
      const own = (p as { owner?: string }).owner ?? ref;
      const pen = [...new Set(hs.filter(([k]) => k === "courtyard").map(([, o]) => o))].reduce((s, o) => s + (o !== own ? plan.courtyard_penalty : 0.5), 0);
      ok.push([c[0] + pen, c[1], c[2], c[3]]);
    }
    ok.sort((a, b) => a[0] - b[0]);
    free.set(ref, ok);
  }
  const placed: Record<string, Placed> = {};
  const why: Record<string, unknown> = {};
  for (const [ref, pin] of Object.entries(plan.pin)) {
    if (!(ref in parts)) continue;
    const p = P(ref);
    const hgt = pin.height ?? plan.heights[0]!;
    const [tw, th] = tb(labelText(ref, plan), hgt, plan.stroke);
    const ang = pin.angle ?? 0;
    const [w_, h_] = ang % 180 === 0 ? [tw, th] : [th, tw];
    const [x, y] = pin.at;
    const rect: Rect = [x - w_ / 2, y - h_ / 2, x + w_ / 2, y + h_ / 2];
    placed[ref] = [0, rect, ang, hgt];
    w.addLabel(ref, p.side, rect);
  }
  // dynamic most-constrained-first: next is the label with the fewest live spots; among its spots, prefer the one that
  // kills the fewest live spots of labels still to place (score + spot_cost per spot killed)
  const cl = plan.clear.label!;
  const spotGrid = { F: new Grid<Kind>(), B: new Grid<Kind>() };
  for (const ref of todo) {
    if (ref in placed) continue;
    free.get(ref)!.forEach((c, j) => {
      const r = c[1];
      spotGrid[P(ref).side].add("spot", [ref, j], [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], r);
    });
  }
  const live = new Map<string, Set<number>>();
  for (const ref of todo) if (!(ref in placed)) live.set(ref, new Set(free.get(ref)!.map((_, i) => i)));
  const kill = (side: "F" | "B", rect: Rect, owner: string) => {
    for (const [, it] of spotGrid[side].near(grow(rect, cl))) {
      if (!it) continue;
      const [ref2, j] = it.owner as [string, number];
      if (ref2 !== owner && live.has(ref2) && overlap(grow(rect, cl), it.bb)) live.get(ref2)!.delete(j);
    }
  };
  for (const [ref, pl] of Object.entries(placed)) kill(P(ref).side, pl[1], ref);
  while (live.size) {
    // free texts first: they carry the functional names
    let ref = "";
    let bk: [boolean, boolean, number, string] | null = null;
    for (const [r, s] of live) {
      const key: [boolean, boolean, number, string] = [!P(r).is_text, s.size === 0, s.size, r];
      if (!bk || key[0] < bk[0] || (key[0] === bk[0] && (key[1] < bk[1] || (key[1] === bk[1] && (key[2] < bk[2] || (key[2] === bk[2] && key[3] < bk[3])))))) {
        bk = key;
        ref = r;
      }
    }
    const spots = live.get(ref)!;
    live.delete(ref);
    const p = P(ref);
    if (!spots.size) {
      why[ref] = !free.get(ref)!.length ? "no free spot" : "spots taken by other labels";
      for (const [s, it] of oldStrokes.get(ref) ?? []) {
        // ...unless it stays where it is
        w.g[s].add(it.kind, it.owner, it.poly, it.bb);
        kill(s, it.bb, ref);
      }
      continue;
    }
    let best: [number, Rect, number, number] | null = null;
    let bscore: number | null = null;
    for (const j of [...spots].sort((a, b) => a - b).slice(0, 40)) {
      const c = free.get(ref)![j]!;
      let cost = 0;
      for (const [, it] of spotGrid[p.side].near(grow(c[1], cl))) {
        if (!it) continue;
        const [ref2, j2] = it.owner as [string, number];
        if (live.has(ref2) && live.get(ref2)!.has(j2) && overlap(grow(c[1], cl), it.bb)) cost += 1.0 / Math.max(1, live.get(ref2)!.size);
      }
      const sc = c[0] + plan.spot_cost * cost;
      if (bscore === null || sc < bscore) {
        best = c;
        bscore = sc;
      }
    }
    placed[ref] = best!;
    w.addLabel(ref, p.side, best![1]);
    kill(p.side, best![1], ref);
  }
  const whyOut: SolveResult["why"] = {};
  for (const ref of Object.keys(why)) {
    // what blocks it: the agent's lever (move, smaller, skip)
    const p = P(ref);
    const kinds: Record<string, number> = {};
    for (const c of cands.get(ref)!.slice(0, 60)) {
      for (const k of new Set(w.hits(p.side, c[1], ref, [], matches(ref, plan.inside_ok)).map(([k]) => k).filter((k) => k !== "courtyard"))) kinds[k] = (kinds[k] ?? 0) + 1;
      if (!plan.ambiguous_ok && w.whose(p.side, c[1], ref, SOLVER_TOL)) kinds["ambiguous"] = (kinds["ambiguous"] ?? 0) + 1;
    }
    whyOut[ref] = { reason: why[ref] as string, blocked_by_of_60_best: kinds };
  }
  // repair: move one blocking label to another of its spots
  for (let round = 0; round < 3; round++) {
    let progress = false;
    for (const ref of Object.keys(whyOut).filter((r) => free.get(r)!.length)) {
      const p = P(ref);
      let done = false;
      for (const c of free.get(ref)!.slice(0, 200)) {
        const blockers = new Set(w.hits(p.side, c[1], ref, [], true).filter(([k]) => k === "label").map(([, o]) => o));
        if (blockers.size !== 1) continue;
        const [bl] = [...blockers] as [string];
        if (bl in plan.pin) continue;
        const old = placed[bl]!;
        w.dropLabel(bl);
        w.addLabel(ref, p.side, c[1]);
        for (const c2 of free.get(bl)!) {
          if (c2[1].every((v, i) => v === old[1][i])) continue;
          if (!w.hits(P(bl).side, c2[1], bl, [], true).some(([k]) => k === "label")) {
            placed[bl] = c2;
            w.addLabel(bl, P(bl).side, c2[1]);
            placed[ref] = c;
            done = true;
            break;
          }
        }
        if (done) break;
        w.dropLabel(ref);
        w.addLabel(bl, P(bl).side, old[1]);
      }
      if (done) {
        delete whyOut[ref];
        progress = true;
      }
    }
    if (!progress) break;
  }
  log(`solve: ${Object.keys(placed).length}/${todo.length} labels placed, ${Object.keys(whyOut).length} fit nowhere (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { placed, why: whyOut, todo };
}
