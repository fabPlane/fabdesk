/**
 * Connection-level rip-up (toolkit tools/rip_items.py): remove selected copper from a scored board and keep the rest of
 * each net. Selections are a union:
 *
 *   --drc TYPES            tracks/vias named in the board's refilled DRC violations of these types; with
 *                          --spare-open-nets DIR the side that was open on board DIR (the new route) stays and only what
 *                          it collides with is cut, so the blocker is re-routed round it
 *   --a7                   power-class segments below class width outside the neck allowance (acceptance A7)
 *   --a8 [all|short|long]  every segment and via of pair nets failing A8; short = legs whose pads are closer than the
 *                          coupling threshold, long = the rest; --around-ripped MM also cuts the copper within MM of
 *                          those nets' pads
 *   --a8-uncoupled [REGEX] only the uncoupled stretches of failing pairs, vias left with no kept copper and kept copper no
 *                          longer reaching a pad (these nets are not pruned); --rip-pad-stubs: uncoupled pad stubs too
 *   --window X0 Y0 X1 Y1   segments with an end inside the box and vias inside it (repeatable)
 *   --around-opens MM      a +-MM box round each end of every open connection
 *   --nets PATTERNS        limits windows to nets matching these fnmatch patterns ('!' prefix excludes)
 *   --spare-pairs          windows never cut pair nets; in a --drc finding between a pair net and another net only the
 *                          other net is cut
 *   --no-prune             keep the dangling copper the rip leaves
 *
 * The board's ground net is never cut by a window. Dangling copper left by the rip is pruned back to the next junction,
 * pad or via, only on the nets that were cut. The selection and the edit are pure functions of board text and data;
 * only `ripStep` touches files.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profile, pyRound, undersizeSegments } from "../accept";
import { parseBoard, viaSpan, type Pad, type Segment, type Via } from "../board";
import type { Acceptance, NetClassSpec, Requirements } from "../requirements";
import { topLevelSpans, type Span } from "../sexpr";
import { copyBoardFolder } from "./bench";
import type { DrcRun } from "./scoring";

type Pt = [number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------------------------------------------------------
// Options (rip_items.py's argparse)
// ---------------------------------------------------------------------------------------------------------------

export interface RipOptions {
  /** `--drc TYPE[,TYPE..]` */
  drc?: string;
  a7?: boolean;
  /** `--a8 [all|short|long]` (bare `--a8` is `all`). */
  a8?: "all" | "short" | "long";
  /** `--a8-uncoupled [REGEX]` (bare is `""`: every failing pair). */
  a8Uncoupled?: string;
  ripPadStubs?: boolean;
  aroundRipped?: number;
  /** `--window X0 Y0 X1 Y1`, repeatable. */
  window: number[][];
  aroundOpens?: number;
  /** `--nets PATTERN[,PATTERN..]` */
  nets?: string;
  noPrune?: boolean;
  sparePairs?: boolean;
  /** `--spare-open-nets DIR`: a scored board folder. */
  spareOpenNets?: string;
}

const pyFloatArg = (opt: string, s: string | undefined): number => {
  const v = s === undefined || s.trim() === "" ? NaN : Number(s.trim());
  if (!Number.isFinite(v) && !/^\s*[-+]?(inf|infinity)\s*$/i.test(s ?? "")) throw new Error(`rip: ${opt}: invalid float value: '${s ?? ""}'`);
  return Number.isFinite(v) ? v : (s ?? "").trim().startsWith("-") ? -Infinity : Infinity;
};

/** argparse's test for a value token: anything not starting with '-', a negative number, or a token holding a space. */
const isValue = (s: string | undefined): s is string => s !== undefined && (!s.startsWith("-") || /^-\d+$|^-\d*\.\d+$/.test(s) || s.includes(" ") || s === "-");

/** rip_items.py options (everything after SRC OUT) to RipOptions; unknown options throw. */
export function parseRipArgs(args: readonly string[]): RipOptions {
  const o: RipOptions = { window: [] };
  const toks: string[] = [];
  for (const t of args) {
    const eq = t.startsWith("--") ? t.indexOf("=") : -1;
    if (eq > 0) toks.push(t.slice(0, eq), t.slice(eq + 1));
    else toks.push(t);
  }
  const need = (i: number, opt: string): string => {
    const v = toks[i];
    if (!isValue(v)) throw new Error(`rip: ${opt}: expected one argument`);
    return v;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    switch (t) {
      case "--drc":
        o.drc = need(++i, t);
        break;
      case "--a7":
        o.a7 = true;
        break;
      case "--a8": {
        if (isValue(toks[i + 1])) {
          const v = toks[++i]!;
          if (v !== "all" && v !== "short" && v !== "long") throw new Error(`rip: --a8: invalid choice: '${v}' (choose from 'all', 'short', 'long')`);
          o.a8 = v;
        } else o.a8 = "all";
        break;
      }
      case "--a8-uncoupled":
        o.a8Uncoupled = isValue(toks[i + 1]) ? toks[++i]! : "";
        break;
      case "--rip-pad-stubs":
        o.ripPadStubs = true;
        break;
      case "--around-ripped":
        o.aroundRipped = pyFloatArg(t, need(++i, t));
        break;
      case "--window": {
        const w: number[] = [];
        for (let k = 0; k < 4; k++) {
          if (!isValue(toks[i + 1])) throw new Error("rip: --window: expected 4 arguments");
          w.push(pyFloatArg(t, toks[++i]));
        }
        o.window.push(w);
        break;
      }
      case "--around-opens":
        o.aroundOpens = pyFloatArg(t, need(++i, t));
        break;
      case "--nets":
        o.nets = need(++i, t);
        break;
      case "--no-prune":
        o.noPrune = true;
        break;
      case "--spare-pairs":
        o.sparePairs = true;
        break;
      case "--spare-open-nets":
        o.spareOpenNets = need(++i, t);
        break;
      default:
        throw new Error(`rip: unrecognized argument: ${t}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Board items and helpers
// ---------------------------------------------------------------------------------------------------------------

export interface RipItem {
  kind: "segment" | "via" | "arc";
  span: Span;
  net: string;
  /** Every `(start|end|at|mid x y)` in the item, in text order. */
  pts: Pt[];
  /** `(layer "X")`; null for vias (they write `layers`). */
  layer: string | null;
  uuid: string | null;
}

/** Segments, then vias, then arcs, each in file order (rip_items.items). */
export function ripItems(text: string): RipItem[] {
  const out: RipItem[] = [];
  for (const kind of ["segment", "via", "arc"] as const) {
    for (const span of topLevelSpans(text, kind)) {
      const it = text.slice(span.start, span.end);
      out.push({
        kind,
        span,
        net: /\(net "([^"]*)"\)/.exec(it)?.[1] ?? "",
        pts: [...it.matchAll(/\((?:start|end|at|mid) ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as Pt),
        layer: /\(layer "([^"]+)"\)/.exec(it)?.[1] ?? null,
        uuid: /\(uuid "([^"]*)"\)/.exec(it)?.[1] ?? null,
      });
    }
  }
  return out;
}

const FNMATCH = new Map<string, RegExp>();
/** Python's fnmatch.translate (case-sensitive, whole string). */
export function fnmatchRegex(pat: string): RegExp {
  const hit = FNMATCH.get(pat);
  if (hit) return hit;
  let i = 0;
  let res = "";
  const n = pat.length;
  while (i < n) {
    const c = pat[i++]!;
    if (c === "*") res += ".*";
    else if (c === "?") res += ".";
    else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) res += "\\[";
      else {
        let stuff = pat.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        res += `[${stuff.replace(/\[/g, "\\[")}]`;
      }
    } else res += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  const rx = new RegExp(`^(?:${res})$`, "s");
  FNMATCH.set(pat, rx);
  return rx;
}

/**
 * sexpr.removeSpans in one pass: the blanks before each span go with it, the line break stays. Same text as removing
 * the spans one by one from the last (the toolkit's `text[:s].rstrip(' \t') + text[e:]`), without copying the board
 * once per span. Spans must not overlap.
 */
export function cutSpans(text: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const s of sorted) {
    parts.push(text.slice(at, s.start).replace(/[ \t]+$/, ""));
    at = s.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** rip_items.match: no patterns match everything; '!' patterns exclude. */
export function matchNets(net: string, patterns: readonly string[] | null): boolean {
  if (!patterns || !patterns.length) return true;
  const inc = patterns.filter((p) => !p.startsWith("!"));
  const exc = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return (!inc.length || inc.some((p) => fnmatchRegex(p).test(net))) && !exc.some((p) => fnmatchRegex(p).test(net));
}

/** Python's round(x, 3), exactly (ties to even on the binary value); fast away from ties. */
function round3(x: number): number {
  const y = x * 1000;
  const f = y - Math.floor(y);
  if (Math.abs(f - 0.5) < 1e-6) return pyRound(x, 3);
  return Math.round(y) / 1000;
}
const r3 = (x: number) => String(round3(x) + 0); // -0 prints as 0, and Python's -0.0 == 0.0

const firstBracket = (s: string) => /\[([^\]]*)\]/.exec(s)?.[1];

type DrcItemLite = { description: string; uuid?: string; pos?: { x: number; y: number } };
type DrcLike = {
  violations: Array<{ rule?: string; type?: string; items?: DrcItemLite[] }>;
  unconnected?: Array<{ items: DrcItemLite[] }>;
  unconnected_items?: Array<{ items: DrcItemLite[] }>;
};
/** The open connections of a DRC run (a DrcRun's `unconnected`, or kicad-cli's raw `unconnected_items`). */
const unconnectedOf = (d: DrcLike) => d.unconnected ?? d.unconnected_items ?? [];
/** Every net named by an open connection (the first `[NET]` of each item's description). */
export function openNetsOf(d: DrcLike): Set<string> {
  const s = new Set<string>();
  for (const u of unconnectedOf(d)) for (const it of u.items) {
    const n = firstBracket(it.description);
    if (n !== undefined) s.add(n);
  }
  return s;
}

/** Pad copper layers as the toolkit's board model sees them: `*.Cu` is every layer of the stack. */
const padLayers = (p: Pad, stack: readonly string[]): Set<string> =>
  p.layers.some((l) => l.startsWith("*")) ? new Set(stack) : new Set(p.layers.filter((l) => l.endsWith(".Cu")));

const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L2));
  return Math.hypot(p[0] - a[0] - u * (b[0] - a[0]), p[1] - a[1] - u * (b[1] - a[1]));
};

// ---------------------------------------------------------------------------------------------------------------
// Prune (route_region.prune_dangling, with the toolkit's exact round(x, 3) end keys)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Repeatedly drop segments with a free end (not on a pad, via or another segment of the net) and vias joined to
 * nothing; `only`: just these nets. Same as edit/prune.ts `pruneDangling` except that ends are keyed by Python's
 * round(x, 3) (prune.ts uses Math.round(x * 1000) / 1000, which differs from the toolkit at half-way coordinates).
 */
export function pruneDanglingExact(text: string, only?: ReadonlySet<string>): { text: string; pruned: number } {
  const board = parseBoard(text);
  const padAt = new Map<string, Array<[number, number, number]>>();
  for (const p of board.pads) (padAt.get(p.net) ?? padAt.set(p.net, []).get(p.net)!).push([p.x, p.y, Math.max(p.r, 0.15)]);
  const zoneNets = new Set([...text.matchAll(/\(zone\s+\(net "([^"]+)"\)/g)].map((m) => m[1]!));
  let total = 0;
  for (;;) {
    const items: Array<{ kind: string; span: Span; net: string; pts: Pt[] }> = [];
    for (const kind of ["segment", "via", "arc"]) {
      for (const span of topLevelSpans(text, kind)) {
        const it = text.slice(span.start, span.end);
        items.push({
          kind,
          span,
          net: /\(net "([^"]*)"\)/.exec(it)?.[1] ?? "",
          pts: [...it.matchAll(/\((?:start|end|at) ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as Pt),
        });
      }
    }
    const key = (net: string, x: number, y: number) => `${net}\u0000${r3(x)}\u0000${r3(y)}`;
    const ends = new Map<string, number>();
    for (const it of items) for (const [x, y] of it.pts) ends.set(key(it.net, x, y), (ends.get(key(it.net, x, y)) ?? 0) + 1);
    const segsByNet = new Map<string, Array<[Pt, Pt, number, number]>>();
    for (const it of items) {
      if (it.kind !== "via" && it.pts.length >= 2) {
        const w = /\(width ([-\d.]+)\)/.exec(text.slice(it.span.start, it.span.end));
        (segsByNet.get(it.net) ?? segsByNet.set(it.net, []).get(it.net)!).push([it.pts[0]!, it.pts[it.pts.length - 1]!, w ? Number(w[1]) : 0.15, it.span.start]);
      }
    }
    const onPad = (net: string, x: number, y: number, own?: number): boolean => {
      for (const [px, py, r] of padAt.get(net) ?? []) if ((x - px) ** 2 + (y - py) ** 2 <= r * r) return true;
      for (const [[ax, ay], [bx, by], w, s] of segsByNet.get(net) ?? []) {
        if (s === own) continue;
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2));
        if ((x - ax - u * (bx - ax)) ** 2 + (y - ay - u * (by - ay)) ** 2 <= (w / 2) ** 2) return true;
      }
      return false;
    };
    const drop: Span[] = [];
    for (const it of items) {
      if (zoneNets.has(it.net) || (only && !only.has(it.net))) continue;
      if (it.kind === "via") {
        const [x, y] = it.pts[0]!;
        if ((ends.get(key(it.net, x, y)) ?? 0) <= 2 && !onPad(it.net, x, y)) drop.push(it.span);
      } else {
        for (const [x, y] of [it.pts[0]!, it.pts[it.pts.length - 1]!]) {
          if ((ends.get(key(it.net, x, y)) ?? 0) <= 1 && !onPad(it.net, x, y, it.span.start)) {
            drop.push(it.span);
            break;
          }
        }
      }
    }
    if (!drop.length) return { text, pruned: total };
    text = cutSpans(text, drop);
    total += drop.length;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Selection and edit
// ---------------------------------------------------------------------------------------------------------------

/** What a rip reads besides the board: the board's DRC run and acceptance result, and the spare board's DRC run. */
export interface RipInputs {
  drc: DrcLike;
  /** The `checkAcceptance` result of the board (only `results.A8_pairs.detail` is read). */
  acceptance: { results: { A8_pairs?: { detail?: Record<string, unknown> } } };
  /** `--spare-open-nets`: the DRC run of that board. */
  spareDrc?: DrcLike;
}

/** The board facts the toolkit took from boardctx: ground net (never cut by a window) and copper stack. */
export interface RipContext {
  acceptance: Acceptance;
  ground: string;
  stack: readonly string[];
}

export function ripContext(req: Requirements): RipContext {
  const p = profile(req.acceptance);
  return { acceptance: req.acceptance, ground: p.ground, stack: p.copper };
}

export interface RipSelection {
  /** Indices into `ripItems(text)`, ascending. */
  picked: number[];
  /** Selections per reason, counted per selection (an item picked twice counts twice), in first-seen order. */
  byReason: Record<string, number>;
  /** Nets --a8 / --a8-uncoupled ripped (listed first in `open_before`). */
  a8Nets: string[];
  /** --a8-uncoupled nets: not pruned. */
  keepUnpruned: Set<string>;
  /** Every window box (explicit, --around-ripped, --around-opens). */
  windows: number[][];
}

/** The items a rip removes (rip_items.py main, up to the edit). */
export function selectRip(text: string, items: readonly RipItem[], o: RipOptions, inp: RipInputs, ctx: RipContext): RipSelection {
  const acc = ctx.acceptance;
  const classes = acc.net_classes.classes as Record<string, NetClassSpec>;
  const pick = new Set<number>();
  const why: Record<string, number> = {};
  let a8Nets: string[] = [];
  const take = (i: number, reason: string) => {
    pick.add(i);
    why[reason] = (why[reason] ?? 0) + 1;
  };
  const near = (p: Pt, q: Pt, tol = 2e-3) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
  const pairNets = new Set<string>();
  if (o.sparePairs) for (const c of Object.values(classes)) for (const pr of c.pairs ?? []) for (const n of pr) pairNets.add(n);
  const spare = new Set<string>();
  if (o.spareOpenNets !== undefined) {
    if (!inp.spareDrc) throw new Error("rip: --spare-open-nets needs that board's DRC run");
    for (const n of openNetsOf(inp.spareDrc)) spare.add(n);
  }
  if (o.drc !== undefined) {
    const types = new Set(o.drc.split(","));
    const DESC = /^(Track|Via) \[([^\]]*)\] on ([\w.]+)/;
    for (const v of inp.drc.violations) {
      if (!types.has(v.rule ?? v.type ?? "")) continue;
      const vItems = v.items ?? [];
      for (const d of vItems) {
        const m = DESC.exec(d.description);
        if (!m) continue;
        const net = m[2]!;
        const others = new Set<string>();
        for (const x of vItems) {
          const b = firstBracket(x.description);
          if (b !== undefined && b !== net) others.add(b);
        }
        if (spare.has(net) && [...others].some((x) => !spare.has(x))) continue; // the new route stays; its partner is ripped
        if (pairNets.has(net) && [...others].some((x) => !pairNets.has(x))) continue; // --spare-pairs: the other net is re-routed
        if (!d.pos) throw new Error(`rip: DRC item without a position: ${d.description}`);
        const pos: Pt = [d.pos.x, d.pos.y];
        items.forEach((it, i) => {
          if (it.net !== net || (m[1] === "Via") !== (it.kind === "via")) return;
          if (it.kind !== "via" && it.layer !== m[3]) return;
          if (it.pts.some((p) => near(pos, p))) take(i, v.rule ?? v.type ?? "");
        });
      }
    }
  }
  const keepUnpruned = new Set<string>();
  const windows: number[][] = o.window.map((w) => [...w]);
  if (o.a7 || o.a8 !== undefined || o.a8Uncoupled !== undefined) {
    const board = parseBoard(text);
    const pads = board.pads;
    const by = new Map<string, Pad[]>();
    for (const p of pads) (by.get(p.net) ?? by.set(p.net, []).get(p.net)!).push(p);
    if (o.a7) {
      const bad = new Set(undersizeSegments(board.segments, board.vias, pads, acc, ctx.stack).map(([n, s]) => `${n}\u0000${s.a[0]},${s.a[1]}\u0000${s.b[0]},${s.b[1]}\u0000${s.layer}`));
      items.forEach((it, i) => {
        if (it.kind !== "segment" || !it.pts.length) return;
        const a = it.pts[0]!, b = it.pts[it.pts.length - 1]!;
        if (bad.has(`${it.net}\u0000${a[0] + 0},${a[1] + 0}\u0000${b[0] + 0},${b[1] + 0}\u0000${it.layer}`)) take(i, "a7");
      });
    }
    const failingAll = () => new Set(Object.keys(inp.acceptance.results.A8_pairs?.detail ?? {}));
    if (o.a8 !== undefined) {
      let failing = failingAll();
      const span = (n: string) => {
        let m = 0;
        const ps = by.get(n) ?? [];
        for (const p of ps) for (const q of ps) m = Math.max(m, dist([p.x, p.y], [q.x, q.y]));
        return m;
      };
      const limit = new Map<string, number>();
      for (const c of Object.values(classes)) for (const pr of c.pairs ?? []) for (const n of pr) limit.set(n, c.coupling_applies_from_mm ?? 7.0);
      if (o.a8 !== "all") failing = new Set([...failing].filter((n) => (span(n) < (limit.get(n) ?? 7.0)) === (o.a8 === "short")));
      a8Nets = [...failing].sort();
      items.forEach((it, i) => {
        if (failing.has(it.net)) take(i, "a8");
      });
      if (o.aroundRipped !== undefined) {
        const m = o.aroundRipped;
        // the toolkit walks a Python set here (hash order); sorted order gives the same boxes
        for (const n of a8Nets) for (const p of by.get(n) ?? []) windows.push([p.x - m, p.y - m, p.x + m, p.y + m]);
      }
    }
    if (o.a8Uncoupled !== undefined) {
      const failing = failingAll();
      const rx = o.a8Uncoupled ? new RegExp(o.a8Uncoupled) : null;
      const todo: Array<[[string, string], number]> = [];
      for (const c of Object.values(classes))
        for (const pr of c.pairs ?? [])
          if (pr.some((n) => failing.has(n)) && (!rx || pr.some((n) => rx.test(n)))) todo.push([pr, (c.diff_pair_width! + c.diff_pair_gap!) * 1.25]);
      const layerSets = new Map<Pad, Set<string>>();
      const layersOf = (p: Pad) => layerSets.get(p) ?? layerSets.set(p, padLayers(p, ctx.stack)).get(p)!;
      for (const [[pn, nn], reach] of todo) {
        const idx = items.flatMap((it, i) => (it.net === pn || it.net === nn ? [i] : []));
        const ownPads = pads.filter((q) => q.net === pn || q.net === nn);
        const onPad = (q: Pt, net: string, L: string | null) =>
          ownPads.some((o2) => o2.net === net && L !== null && layersOf(o2).has(L) && dist(q, [o2.x, o2.y]) <= o2.r);
        const rip = new Set<number>();
        for (const i of idx) {
          const it = items[i]!;
          if (it.kind !== "segment") continue;
          const a = it.pts[0]!, b = it.pts[it.pts.length - 1]!;
          if (!o.ripPadStubs && (onPad(a, it.net, it.layer) || onPad(b, it.net, it.layer))) continue;
          const mates = idx.map((j) => items[j]!).filter((x) => x.kind === "segment" && x.net !== it.net && x.layer === it.layer);
          const L = dist(a, b);
          const k = Math.max(1, Math.trunc(L / 0.1));
          let far = 0;
          for (let s = 0; s < k; s++) {
            const u = (s + 0.5) / k;
            const q: Pt = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
            const dmin = mates.length ? Math.min(...mates.map((m) => segDist(q, m.pts[0]!, m.pts[m.pts.length - 1]!))) : 9;
            if (dmin > reach) far++;
          }
          if (far > k / 2) rip.add(i);
        }
        // kept copper must still reach a pad of its net (through segments and vias); islands go too
        const par = new Map<string, string>();
        const find = (x: string): string => {
          if (!par.has(x)) par.set(x, x);
          while (par.get(x) !== x) {
            par.set(x, par.get(par.get(x)!)!);
            x = par.get(x)!;
          }
          return x;
        };
        const I = (i: number) => `i${i}`;
        const kept = idx.filter((i) => !rip.has(i));
        const keptVias = kept.filter((i) => items[i]!.kind === "via");
        for (const i of kept) {
          const it = items[i]!;
          if (it.kind !== "segment") continue;
          for (const q of [it.pts[0]!, it.pts[it.pts.length - 1]!]) {
            const rk = find(`p${r3(q[0])}\u0000${r3(q[1])}\u0000${it.layer}\u0000${it.net}`);
            par.set(find(I(i)), rk);
            for (const v of keptVias) if (items[v]!.net === it.net && dist(q, items[v]!.pts[0]!) < 0.05) par.set(find(I(v)), find(I(i)));
          }
        }
        const anchored = new Set<string>();
        for (const i of kept) {
          const it = items[i]!;
          const pts = it.kind === "segment" ? [it.pts[0]!, it.pts[it.pts.length - 1]!] : it.pts.slice(0, 1);
          const lay = it.kind === "segment" ? [it.layer] : [...ctx.stack];
          if (pts.some((q) => lay.some((L) => onPad(q, it.net, L)))) anchored.add(find(I(i)));
        }
        for (const i of kept) if (!anchored.has(find(I(i)))) rip.add(i);
        for (const i of rip) take(i, "a8-uncoupled");
        keepUnpruned.add(pn).add(nn);
        a8Nets.push(pn, nn);
      }
    }
  }
  if (o.aroundOpens !== undefined) {
    const m = o.aroundOpens;
    for (const u of unconnectedOf(inp.drc))
      for (const d of u.items) {
        if (!d.pos) throw new Error(`rip: open item without a position: ${d.description}`);
        windows.push([d.pos.x - m, d.pos.y - m, d.pos.x + m, d.pos.y + m]);
      }
  }
  const pats = o.nets ? o.nets.split(",") : null;
  items.forEach((it, i) => {
    if (it.net === ctx.ground || pairNets.has(it.net) || !matchNets(it.net, pats)) return;
    if (it.pts.some(([x, y]) => windows.some((b) => b[0]! <= x && x <= b[2]! && b[1]! <= y && y <= b[3]!))) take(i, "window");
  });
  return { picked: [...pick].sort((a, b) => a - b), byReason: why, a8Nets, keepUnpruned, windows };
}

/** rip.json: field names and meaning as the toolkit's (the KRT plan runner reads `nets` and `open_before`). */
export interface RipRecord {
  src: string;
  removed: number;
  by_reason: Record<string, number>;
  pruned: number;
  nets: string[];
  windows: number[][];
  /** route_krt "@open-before": route these first, then what the rip opened. */
  open_before: string[];
}

/** Rip a board: the selection, the removal and the prune. Pure: board text and data in, board text and record out. */
export function ripBoard(text: string, o: RipOptions, inp: RipInputs, ctx: RipContext, src = ""): { text: string; record: RipRecord; removedItems: RipItem[] } {
  const items = ripItems(text);
  const sel = selectRip(text, items, o, inp, ctx);
  const removedItems = sel.picked.map((i) => items[i]!);
  const nets = [...new Set(removedItems.map((it) => it.net))].sort();
  let out = cutSpans(text, removedItems.map((it) => it.span));
  let pruned = 0;
  if (!o.noPrune) {
    const r = pruneDanglingExact(out, new Set(nets.filter((n) => !sel.keepUnpruned.has(n)))); // only the nets this rip touched
    out = r.text;
    pruned = r.pruned;
  }
  const openBefore = [...new Set([...openNetsOf(inp.drc), ...sel.a8Nets])].sort();
  return { text: out, removedItems, record: { src, removed: removedItems.length, by_reason: sel.byReason, pruned, nets, windows: sel.windows, open_before: openBefore } };
}

// ---------------------------------------------------------------------------------------------------------------
// rip.json as Python's json.dumps(rec, indent=1) writes it
// ---------------------------------------------------------------------------------------------------------------

/** Python's repr of a float. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const a = Math.abs(x);
  if (a < 1e-4 || a >= 1e16) return x.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  const s = String(x);
  return s.includes(".") ? s : s + ".0";
}

const pyStr = (s: string) => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** `json.dumps(rec, indent=1) + "\n"`: window coordinates are floats, counts are ints. */
export function ripJson(rec: RipRecord): string {
  const pad = (n: number) => " ".repeat(n);
  const list = (xs: string[], lvl: number) => (xs.length ? `[\n${xs.map((x) => pad(lvl + 1) + x).join(",\n")}\n${pad(lvl)}]` : "[]");
  const dict = (kv: Array<[string, string]>, lvl: number) => (kv.length ? `{\n${kv.map(([k, v]) => `${pad(lvl + 1)}${pyStr(k)}: ${v}`).join(",\n")}\n${pad(lvl)}}` : "{}");
  return (
    dict(
      [
        ["src", pyStr(rec.src)],
        ["removed", String(rec.removed)],
        ["by_reason", dict(Object.entries(rec.by_reason).map(([k, v]) => [k, String(v)]), 1)],
        ["pruned", String(rec.pruned)],
        ["nets", list(rec.nets.map(pyStr), 1)],
        ["windows", list(rec.windows.map((w) => list(w.map(pyFloatRepr), 2)), 1)],
        ["open_before", list(rec.open_before.map(pyStr), 1)],
      ],
      0,
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------------------------

const exists = (p: string) => stat(p).then(() => true, () => false);

async function readScored(dir: string): Promise<{ drc: DrcRun; acceptance: RipInputs["acceptance"] }> {
  const drcFile = join(dir, ".lastmile", "drc-run.json");
  const accFile = join(dir, ".lastmile", "acceptance.json");
  if (!(await exists(drcFile))) throw new Error(`rip: ${drcFile} is missing (the board folder is not scored)`);
  if (!(await exists(accFile))) throw new Error(`rip: ${accFile} is missing (the board folder is not scored)`);
  return { drc: JSON.parse(await readFile(drcFile, "utf8")), acceptance: JSON.parse(await readFile(accFile, "utf8")) };
}

/**
 * rip_items.py SRC OUT ARGS: `cur` is a scored board folder (`<pcb>`, `.lastmile/drc-run.json`, `.lastmile/acceptance.json`);
 * `out` becomes a copy of it with the ripped board and `rip.json`. Returns the record.
 */
export async function ripStep(o: { cur: string; out: string; pcb: string; args: string[]; req: Requirements }): Promise<RipRecord> {
  const opts = parseRipArgs(o.args);
  if ((await exists(o.out)) && (await readdir(o.out)).length) throw new Error(`rip: ${o.out} exists`);
  const { drc, acceptance } = await readScored(o.cur);
  const spareDrc = opts.spareOpenNets !== undefined ? (await readScored(opts.spareOpenNets)).drc : undefined;
  const text = await readFile(join(o.cur, o.pcb), "utf8");
  const r = ripBoard(text, opts, { drc, acceptance, ...(spareDrc ? { spareDrc } : {}) }, ripContext(o.req), o.cur);
  await mkdir(o.out, { recursive: true });
  await copyBoardFolder(o.cur, o.out);
  await writeFile(join(o.out, o.pcb), r.text);
  await writeFile(join(o.out, "rip.json"), ripJson(r.record));
  return r.record;
}
