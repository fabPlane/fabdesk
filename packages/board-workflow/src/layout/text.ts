/**
 * Text-level board edits for the layout stage. Boards are edited as text, not re-serialised, so every byte outside
 * the edit stays as KiCad wrote it (the toolkit's `block_pass.py` / `board_new_copper.py` / `score_route.py` did the same).
 */
import { randomUUID } from "node:crypto";
import { topLevelSpans } from "../sexpr";

export type Span = [number, number];

/**
 * Spans of depth-1 s-expressions starting with `key` (string-aware; works on tab- or space-indented, CRLF and
 * single-line files). The root's direct children only: a `(arc ...)` inside a `gr_poly`/`fp_poly` outline is not one.
 */
export function topLevel(text: string, key: string): Span[] {
  return topLevelSpans(text, key).map((s): Span => [s.start, s.end]);
}

/** Routed copper kinds a router writes: board-level tracks, vias and track arcs. */
export const COPPER_KINDS = ["segment", "via", "arc"] as const;
export type CopperKind = (typeof COPPER_KINDS)[number];

/** Top-level copper items of a board in file order (never an arc nested in a polygon outline). */
export function copperItems(text: string, kinds: readonly CopperKind[] = COPPER_KINDS): Array<{ kind: CopperKind; span: Span }> {
  return kinds.flatMap((kind) => topLevel(text, kind).map((span) => ({ kind, span }))).sort((x, y) => x.span[0] - y.span[0]);
}

/** Top-level copper items that name their net by number (`(net 178)`): the merge must leave none. */
export function numericNetCopper(text: string): number {
  return copperItems(text).filter(({ span: [a, b] }) => /\(net \d+\)/.test(text.slice(a, b))).length;
}

/** `text` without its top-level copper items; each takes the whitespace before it along (the toolkit's `\s+\((segment|via|arc)...`). */
function withoutCopper(text: string): { text: string; removed: Record<string, number> } {
  // one pass joining the kept pieces (removing items one at a time rebuilt the whole text per item: 512 s on jetson)
  const removed: Record<string, number> = {};
  const parts: string[] = [];
  let at = 0;
  for (const { kind, span } of copperItems(text)) {
    let a = span[0];
    while (a > at && /\s/.test(text[a - 1]!)) a--;
    parts.push(text.slice(at, a));
    at = span[1];
    removed[kind] = (removed[kind] ?? 0) + 1;
  }
  parts.push(text.slice(at));
  return { text: parts.join(""), removed };
}

const REF = /\(property\s+"Reference"\s+"([^"]+)"/;
const REF_LEGACY = /\(fp_text\s+reference\s+"?([^"\s)]+)/;

/** ref -> span of its footprint (first definition of a reference wins as the toolkit's last-wins dict, so later duplicates overwrite). */
export function footprintSpans(text: string): Map<string, Span> {
  const out = new Map<string, Span>();
  for (const [a, b] of topLevel(text, "footprint")) {
    const body = text.slice(a, b);
    const m = REF.exec(body) ?? REF_LEGACY.exec(body);
    if (m) out.set(m[1]!, [a, b]);
  }
  return out;
}

export type Pose = [number, number, number];

export function pose(body: string): Pose {
  const t = /\(transform\s+\(translate ([-\d.]+) ([-\d.]+)\)\s+\(rotate ([-\d.]+)\)/.exec(body);
  if (t) return [Number(t[1]), Number(t[2]), Number(t[3])];
  const head = body.slice(0, body.indexOf("(property") < 0 ? body.length : body.indexOf("(property"));
  const at = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(head);
  if (!at) throw new Error("footprint without a pose");
  return [Number(at[1]), Number(at[2]), Number(at[3] ?? 0)];
}

export function side(body: string): "F" | "B" {
  const m = /\(layer "([FB])\.Cu"\)/.exec(body);
  if (!m) throw new Error("footprint without a copper side");
  return m[1] as "F" | "B";
}

const f4 = (x: number) => x.toFixed(4);
const g = (x: number) => String(Number(x.toPrecision(12)));
const mod360 = (x: number) => ((x % 360) + 360) % 360;

const AT = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/g;
const turn = (d: number) => (_m: string, x: string, y: string, a?: string) => `(at ${x} ${y} ${g(mod360(Number(a ?? 0) + d))})`;

/**
 * Footprint body moved to (x1, y1) at rotation r1; child `(at ...)` angles turn by the rotation delta (KiCad stores them
 * absolutely). Handles both pose spellings: `(transform (translate ..) (rotate ..))` and the footprint's own `(at x y r)`.
 * The toolkit's `block_pass.set_pose` handled only the transform spelling: on a board written with `(at ...)` poses its
 * transfer turned the footprint but never moved it.
 */
export function setPose(body: string, x1: number, y1: number, r1: number): string {
  const [x0, y0, r0] = pose(body);
  if (x0 === x1 && y0 === y1 && mod360(r0) === mod360(r1)) return body;
  const d = mod360(r1 - r0);
  if (/\(transform\s+\(translate/.test(body)) {
    let out = body.replace(/\(translate [-\d.]+ [-\d.]+\)/, `(translate ${f4(x1)} ${f4(y1)})`);
    if (d) {
      out = out.replace(/\(rotate [-\d.]+\)/, `(rotate ${g(mod360(r1))})`);
      out = out.replace(AT, turn(d));
    }
    return out;
  }
  const hi = body.indexOf("(property");
  const split = hi < 0 ? body.length : hi;
  const head = body.slice(0, split).replace(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/, `(at ${g(x1)} ${g(y1)} ${g(mod360(r1))})`);
  return head + (d ? body.slice(split).replace(AT, turn(d)) : body.slice(split));
}

/** Copy the placed pose of `refs` from `placed` onto `native`. Side changes are refused. */
export function transferPoses(native: string, placed: string, refs: string[]): { text: string; transferred: number; changed: number } {
  const pf = footprintSpans(placed);
  let changed = 0;
  let text = native;
  for (const ref of refs) {
    const nf = footprintSpans(text).get(ref);
    const pp = pf.get(ref);
    if (!nf) throw new Error(`${ref}: not on the board`);
    if (!pp) throw new Error(`${ref}: not on the placed board`);
    const body = text.slice(nf[0], nf[1]);
    const pbody = placed.slice(pp[0], pp[1]);
    if (side(body) !== side(pbody)) throw new Error(`${ref}: side change not supported`);
    const next = setPose(body, ...pose(pbody));
    if (next !== body) changed++;
    text = text.slice(0, nf[0]) + next + text.slice(nf[1]);
  }
  return { text, transferred: refs.length, changed };
}

/** Remove every board-level track, via and arc (zones, footprints and arcs inside polygon outlines stay). */
export function stripCopper(text: string): { text: string; removed: Record<string, number> } {
  return withoutCopper(text);
}

/** Insert `(locked yes)` after the head line of each named footprint unless one is there already. */
export function lockFootprints(text: string, refs: Iterable<string>): string {
  const spans = footprintSpans(text);
  const ordered = [...refs].filter((r) => spans.has(r)).sort((a, b) => spans.get(b)![0] - spans.get(a)![0]);
  for (const ref of ordered) {
    const s0 = spans.get(ref)![0];
    let headEnd = text.indexOf("\n", s0 + 1);
    const eol = text[headEnd - 1] === "\r" ? "\r\n" : "\n"; // a CRLF board stays CRLF
    if (eol === "\r\n") headEnd--;
    if (!text.slice(s0, headEnd + 40).includes("(locked")) text = text.slice(0, headEnd) + eol + "    (locked yes)" + text.slice(headEnd);
  }
  return text;
}

/** Locked footprints of a board (the toolkit's test: `(locked` within the first 400 characters). */
export function lockedRefs(text: string): Set<string> {
  const out = new Set<string>();
  for (const [ref, [s]] of footprintSpans(text)) if (/\(locked( yes)?\)/.test(text.slice(s, s + 400))) out.add(ref);
  return out;
}

const ATOM_TRANSFORM = /\(transform\s+\(translate ([-\d.]+) ([-\d.]+)\)(?:\s*\(rotate ([-\d.]+)\))?(?:\s*\(scale 1(?:\.0*)? 1(?:\.0*)?\))?\s*\)/g;

/** Native transform nodes to `(at x y r)` poses, which is what KiCadRoutingTools reads. Boards without transforms are returned unchanged. */
export function convertTransforms(text: string): { text: string; converted: number } {
  if (!text.includes("(transform")) return { text, converted: 0 };
  let converted = 0;
  const out = text.replace(ATOM_TRANSFORM, (_m, x: string, y: string, r?: string) => (converted++, `(at ${x} ${y} ${r ?? "0"})`));
  return { text: out, converted };
}

/** Add a rectangular zone before the final `)`. */
export function appendBeforeClose(text: string, extra: string): string {
  return text.slice(0, text.trimEnd().lastIndexOf(")")).trimEnd() + extra + "\n)\n";
}

export function keepoutZone(layer: string, x0: number, y0: number, x1: number, y1: number): string {
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => `(xy ${f4(x!)} ${f4(y!)})`).join(" ");
  return (
    `\n  (zone (net 0) (net_name "") (layer "${layer}") (uuid "${randomUUID()}") (name "block-pass-keepout")` +
    ` (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25)` +
    ` (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints not_allowed))` +
    ` (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts ${pts})))`
  );
}

// ---------------------------------------------------------------- merging router results

const UUID_NODE = /\(uuid "?[^")\s]+"?\)/g;

/** Items keyed by whitespace-normalised content without uuid (a router run with one seed reuses uuids). */
function itemsByContent(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { span } of copperItems(text, ["segment", "via"])) {
    const item = text.slice(...span);
    const key = item.replace(UUID_NODE, "").split(/\s+/).filter(Boolean).join(" ");
    if (!out.has(key)) out.set(key, item);
  }
  return out;
}

const NET_OF = /\(net "((?:[^"\\]|\\.)*)"\)/;
const NUMBER = /-?\d+(?:\.\d+)?(?:e-?\d+)?/gi;

/** A copper item as content: no uuid, whitespace and number formatting normalised (KRT and KiCad print the same item differently). */
function copperKey(item: string): string {
  return item
    .replace(UUID_NODE, "")
    .replace(NUMBER, (n) => String(Math.round(Number(n) * 1e4) / 1e4))
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();
}

/** Top-level copper of a board grouped by net name, each item as content (sorted). */
export function copperByNet(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { span } of copperItems(text)) {
    const item = text.slice(...span);
    const net = NET_OF.exec(item)?.[1] ?? "";
    (out.get(net) ?? out.set(net, []).get(net)!).push(copperKey(item));
  }
  for (const v of out.values()) v.sort();
  return out;
}

/** Nets whose copper differs between two boards (added, removed or moved items), sorted. */
export function changedCopperNets(before: string, after: string): string[] {
  const a = copperByNet(before), b = copperByNet(after);
  const nets = new Set([...a.keys(), ...b.keys()]);
  return [...nets].filter((n) => (a.get(n) ?? []).join("\n") !== (b.get(n) ?? []).join("\n")).sort();
}

/** `text` keeping only the top-level copper items of `nets` (other nets' copper dropped). */
export function keepCopperOfNets(text: string, nets: ReadonlySet<string>): string {
  // one pass, joining the kept pieces: removing items one by one rebuilds the whole board text each time (quadratic: ~8 min
  // on an 87 MB board with 25k copper items). copperItems' spans are ascending and do not overlap.
  const parts: string[] = [];
  let at = 0;
  for (const { span } of copperItems(text)) {
    const net = NET_OF.exec(text.slice(...span))?.[1] ?? "";
    if (!nets.has(net)) {
      parts.push(text.slice(at, span[0]));
      at = span[1];
    }
  }
  parts.push(text.slice(at));
  return parts.join("");
}

export interface MergeStats {
  mode: "add" | "replace" | "as-is" | "ses";
  [k: string]: unknown;
}

/** Copper in `routed` that `source` lacks (segments and vias, keyed by content), appended to `native`. */
export function addNewCopper(native: string, source: string, routed: string): { text: string; stats: MergeStats } {
  const old = itemsByContent(source);
  // the routed board's items once: rebuilding them inside the filter re-parsed the whole board per source item
  // (quadratic: 25k items x an 86 MB board held the daemon at 100% CPU for over 10 min in the eval)
  const now = itemsByContent(routed);
  const added = [...now].filter(([k]) => !old.has(k)).map(([, s]) => s.replace(UUID_NODE, () => `(uuid "${randomUUID()}")`));
  const removed = [...old.keys()].filter((k) => !now.has(k)).length;
  const vias: Record<string, number> = {};
  for (const s of added) {
    if (!s.startsWith("(via")) continue;
    const l = /\(layers "([^"]+)" "([^"]+)"\)/.exec(s);
    const kind = /\(via\s+(micro|blind)?/.exec(s)?.[1] ?? "through";
    const key = `${kind}:${l?.[1]}-${l?.[2]}`;
    vias[key] = (vias[key] ?? 0) + 1;
  }
  const text = native.slice(0, native.trimEnd().lastIndexOf(")")).trimEnd() + (added.length ? "\n" + added.map((s) => "  " + s).join("\n") : "") + "\n)\n";
  return { text, stats: { mode: "add", added_segments: added.filter((s) => s.startsWith("(segment")).length, added_vias: vias, source_items_missing_in_routed: removed } };
}

/** The routed board's copper is the whole result: every native segment/via/arc is removed and all routed copper appended. */
export function replaceCopper(native: string, routed: string): { text: string; stats: MergeStats } {
  const count = (t: string) => {
    const c: Record<CopperKind, number> = { segment: 0, via: 0, arc: 0 };
    for (const { kind } of copperItems(t)) c[kind]++;
    return c;
  };
  const before = count(native);
  const bare = withoutCopper(native).text;
  const items = copperItems(routed);
  const cu = items.map(({ span }) => routed.slice(...span));
  const text = bare.slice(0, bare.trimEnd().lastIndexOf(")")).trimEnd() + "\n" + cu.join("\n") + "\n)\n";
  const routedItems = count(routed);
  return { text, stats: { mode: "replace", native_removed: before, routed_items: routedItems } };
}

/**
 * KiCad 9-style router output names a track's net by number (`(net 178)`, with `(net 178 "NAME")` in the net table);
 * the workflow's checks and the merge work by name. Rewrite the net reference of every segment, via and arc to `(net "NAME")`.
 * A board that already names its nets is returned unchanged. (The toolkit refused such boards as "pre-10 format".)
 */
export function nameCopperNets(text: string): { text: string; renamed: number } {
  const table = new Map<string, string>();
  for (const m of text.matchAll(/^\t\(net (\d+) "((?:[^"\\]|\\.)*)"\)/gm)) table.set(m[1]!, m[2]!);
  if (!table.size) return { text, renamed: 0 };
  let renamed = 0;
  const parts: string[] = [];
  let at = 0;
  for (const { span } of copperItems(text)) {
    const item = text.slice(...span).replace(/\(net (\d+)\)/, (m, n: string) => {
      const name = table.get(n);
      if (name === undefined) return m;
      renamed++;
      return `(net "${name}")`;
    });
    parts.push(text.slice(at, span[0]), item);
    at = span[1];
  }
  parts.push(text.slice(at));
  return { text: parts.join(""), renamed };
}
