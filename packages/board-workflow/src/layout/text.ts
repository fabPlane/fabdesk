/**
 * Text-level board edits for the layout stage. Boards are edited as text, not re-serialised, so every byte outside
 * the edit stays as KiCad wrote it (the toolkit's `block_pass.py` / `board_new_copper.py` / `score_route.py` did the same).
 */
import { randomUUID } from "node:crypto";

export type Span = [number, number];

/** Spans of depth-1 s-expressions starting with `key` (string-aware; works on tab- or space-indented and single-line files). */
export function topLevel(text: string, key: string): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start: number | null = null;
  let inStr = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "(") {
      depth++;
      if (depth === 2 && text.startsWith(key, i + 1) && /[ \n\t\r]/.test(text[i + 1 + key.length] ?? "")) start = i;
    } else if (ch === ")") {
      if (depth === 2 && start !== null) {
        spans.push([start, i + 1]);
        start = null;
      }
      depth--;
    }
  }
  return spans;
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

const ITEM_BODY = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
const ROUTED = new RegExp(String.raw`\s+\((segment|via|arc)\b` + ITEM_BODY + String.raw`\)`, "g");

/** Remove every track, via and arc (zones and footprints stay). */
export function stripCopper(text: string): { text: string; removed: Record<string, number> } {
  const removed: Record<string, number> = {};
  const out = text.replace(ROUTED, (_m, k: string) => ((removed[k] = (removed[k] ?? 0) + 1), ""));
  return { text: out, removed };
}

/** Insert `(locked yes)` after the head line of each named footprint unless one is there already. */
export function lockFootprints(text: string, refs: Iterable<string>): string {
  const spans = footprintSpans(text);
  const ordered = [...refs].filter((r) => spans.has(r)).sort((a, b) => spans.get(b)![0] - spans.get(a)![0]);
  for (const ref of ordered) {
    const s0 = spans.get(ref)![0];
    const headEnd = text.indexOf("\n", s0 + 1);
    if (!text.slice(s0, headEnd + 40).includes("(locked")) text = text.slice(0, headEnd) + "\n    (locked yes)" + text.slice(headEnd);
  }
  return text;
}

/** Locked footprints of a board (the toolkit's test: `(locked` within the first 400 characters). */
export function lockedRefs(text: string): Set<string> {
  const out = new Set<string>();
  for (const [ref, [s]] of footprintSpans(text)) if (/\(locked( yes)?\)/.test(text.slice(s, s + 400))) out.add(ref);
  return out;
}

const ATOM_TRANSFORM = /\(transform\s+\(translate ([-\d.]+) ([-\d.]+)\)(?:\s+\(rotate ([-\d.]+)\))?\s*\)/g;

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

const COPPER_ITEM = new RegExp(String.raw`\((segment|via|arc)\b` + ITEM_BODY + String.raw`\)`, "g");
const NEW_ITEM = new RegExp(String.raw`\((segment|via)\b` + ITEM_BODY + String.raw`\)`, "g");
const UUID_NODE = /\(uuid "?[^")\s]+"?\)/g;

/** Items keyed by whitespace-normalised content without uuid (a router run with one seed reuses uuids). */
function itemsByContent(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(NEW_ITEM)) {
    const key = m[0].replace(UUID_NODE, "").split(/\s+/).filter(Boolean).join(" ");
    if (!out.has(key)) out.set(key, m[0]);
  }
  return out;
}

export interface MergeStats {
  mode: "add" | "replace" | "as-is" | "ses";
  [k: string]: unknown;
}

/** Copper in `routed` that `source` lacks (segments and vias, keyed by content), appended to `native`. */
export function addNewCopper(native: string, source: string, routed: string): { text: string; stats: MergeStats } {
  const old = itemsByContent(source);
  const added = [...itemsByContent(routed)].filter(([k]) => !old.has(k)).map(([, s]) => s.replace(UUID_NODE, () => `(uuid "${randomUUID()}")`));
  const removed = [...old.keys()].filter((k) => !itemsByContent(routed).has(k)).length;
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
  const count = (t: string) => ({ segment: (t.match(/\(segment\b/g) ?? []).length, via: (t.match(/\(via\b/g) ?? []).length, arc: (t.match(/\(arc\b/g) ?? []).length });
  const before = count(native);
  const bare = native.replace(ROUTED, "");
  const cu = [...routed.matchAll(COPPER_ITEM)].map((m) => m[0]);
  const kinds = cu.map((c) => /^\((\w+)/.exec(c)![1]!);
  const text = bare.slice(0, bare.trimEnd().lastIndexOf(")")).trimEnd() + "\n" + cu.join("\n") + "\n)\n";
  const routedItems = { segment: kinds.filter((k) => k === "segment").length, via: kinds.filter((k) => k === "via").length, arc: kinds.filter((k) => k === "arc").length };
  return { text, stats: { mode: "replace", native_removed: before, routed_items: routedItems } };
}
