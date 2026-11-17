/**
 * DRC exclusions that follow an edit. KiCad keys an exclusion (`board.design_settings.drc_exclusions` in the
 * `.kicad_pro`) by rule, marker position in nm and the two item uuids (`rule|x|y|mainUuid|auxUuid`), and matches the
 * string exactly. An edit that moves the excluded parts, or puts an identical part where an excluded one stood (a
 * swap), leaves the owner's exclusion stale and the same intended violation reappears as a new error.
 *
 * Only two cases are carried, both where the new marker is the old one geometrically, so its position is known:
 *  (a) moved together: the new violation has the exclusion's item pair, and every footprint owning those items moved by
 *      one rigid motion; the position is the old one under that motion.
 *  (b) replaced: one item is unchanged, the other now belongs to a footprint with the same footprint id that took the
 *      old owner's pose (within 1 um) in this edit, the old owner moved away or was removed; the position is the old one.
 * Anything else stays a real new violation. The caller re-scores and keeps only the keys KiCad then matches.
 * The toolkit had no exclusion handling; this is fabdesk's own.
 */
import { childLists, listSpanAt, type Span } from "../sexpr";
import { DRC_ERROR_TYPE } from "./drc-error-types";
import { pose, refOf, sideOf } from "./text";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface Exclusion {
  key: string;
  comment: string;
  /** The entry as the project file holds it: written back unchanged while key and comment are. */
  raw?: unknown;
}

/** `rule|x|y|uuid|uuid`, the two-item form KiCad writes for most rules; null for any other form (layer, third item). */
export interface ExclusionKey {
  rule: string;
  x: number;
  y: number;
  a: string;
  b: string;
}

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const KEY = new RegExp(`^([A-Za-z0-9_]+)\\|(-?\\d+)\\|(-?\\d+)\\|(${UUID_RE})\\|(${UUID_RE})$`);

export function parseExclusionKey(key: string): ExclusionKey | null {
  const m = KEY.exec(key);
  if (!m) return null;
  return { rule: m[1]!, x: Number(m[2]), y: Number(m[3]), a: m[4]!.toLowerCase(), b: m[5]!.toLowerCase() };
}

export const exclusionKey = (k: ExclusionKey) => `${k.rule}|${k.x}|${k.y}|${k.a}|${k.b}`;

type Json = Record<string, unknown>;

const RULE_OF_TYPE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(DRC_ERROR_TYPE).map(([k, v]) => [v, k]));

/**
 * The key of one stored entry: a pre-v3 `[key, comment]` / bare key, or a v3 `{comment, marker: {error_type, items,
 * position, layer?}}` turned into the same `rule|x|y|uuid|uuid` form. A v3 entry this cannot express (a layer, an
 * unknown type) gets a key no rule matches, so it is only ever written back as it was.
 */
function decodeEntry(e: unknown): Exclusion | null {
  if (typeof e === "string") return { key: e, comment: "", raw: e };
  if (Array.isArray(e) && typeof e[0] === "string") return { key: e[0], comment: typeof e[1] === "string" ? e[1] : "", raw: e };
  if (!e || typeof e !== "object") return null;
  const o = e as { comment?: unknown; marker?: { error_type?: unknown; items?: Array<{ value?: unknown }>; position?: { x_nm?: unknown; y_nm?: unknown }; layer?: unknown } };
  const comment = typeof o.comment === "string" ? o.comment : "";
  const m = o.marker;
  const rule = typeof m?.error_type === "string" ? RULE_OF_TYPE[m.error_type] : undefined;
  const items = (m?.items ?? []).map((i) => String(i?.value ?? "").toLowerCase());
  const x = Number(m?.position?.x_nm), y = Number(m?.position?.y_nm);
  if (rule && m?.layer === undefined && (items.length === 1 || items.length === 2) && Number.isInteger(x) && Number.isInteger(y))
    return { key: `${rule}|${x}|${y}|${items[0]}|${items[1] ?? NIL_UUID}`, comment, raw: e };
  return { key: `?${JSON.stringify(e)}`, comment, raw: e };
}

/** v3 when the file's design settings say so (`meta.version` >= 3) or it already holds a v3 entry. */
function storesV3(ds: Json | undefined): boolean {
  const list = ds?.["drc_exclusions"];
  if (Array.isArray(list) && list.some((e) => e && typeof e === "object" && !Array.isArray(e))) return true;
  return Number((ds?.["meta"] as Json | undefined)?.["version"] ?? 0) >= 3;
}

function encodeEntry(e: Exclusion, v3: boolean, bare: boolean): unknown {
  if (e.raw !== undefined) {
    const was = decodeEntry(e.raw);
    const sameForm = v3 ? typeof e.raw === "object" && !Array.isArray(e.raw) : typeof e.raw === "string" || Array.isArray(e.raw);
    if (sameForm && was && was.key === e.key && was.comment === e.comment) return e.raw;
  }
  if (!v3) return bare ? e.key : [e.key, e.comment];
  const k = parseExclusionKey(e.key);
  const type = k ? DRC_ERROR_TYPE[k.rule] : undefined;
  if (k && type)
    return { comment: e.comment, marker: { error_type: type, items: [{ value: k.a }, ...(k.b !== NIL_UUID ? [{ value: k.b }] : [])], position: { x_nm: String(k.x), y_nm: String(k.y) } } };
  // a v3 entry whose comment changed, or a pre-v3 key v3 cannot hold: kept as close to the original as possible
  if (e.raw && typeof e.raw === "object" && !Array.isArray(e.raw)) return { ...(e.raw as Json), comment: e.comment };
  return [e.key, e.comment];
}

/**
 * The project's DRC exclusions, in either storage form: KiCad up to design settings v2 writes `[key, comment]` (or a bare
 * key); KiCad 10.99 (v3) writes `{comment, marker: {error_type, items, position}}`. Null when the file has none.
 */
export function readDrcExclusions(proText: string): Exclusion[] | null {
  let pro: Json;
  try {
    pro = JSON.parse(proText) as Json;
  } catch {
    return null;
  }
  const list = (((pro["board"] as Json | undefined)?.["design_settings"] as Json | undefined)?.["drc_exclusions"]) as unknown;
  if (!Array.isArray(list)) return null;
  return list.flatMap((e) => decodeEntry(e) ?? []);
}

/**
 * `proText` with `board.design_settings.drc_exclusions` replaced, in the form the file uses (an entry read from it and
 * left alone is written back byte-identical in value). Only that array's text is rewritten (every other byte of the
 * owner's project file stays as KiCad wrote it); a file without the key is re-written as JSON with it added.
 */
export function withDrcExclusions(proText: string, entries: readonly Exclusion[]): string {
  const pro = JSON.parse(proText) as Json;
  const ds = (((pro["board"] ??= {}) as Json)["design_settings"] ??= {}) as Json;
  const was = ds["drc_exclusions"];
  const v3 = storesV3(ds);
  const bare = Array.isArray(was) && was.length > 0 && was.every((e) => typeof e === "string");
  const value = entries.map((e) => encodeEntry(e, v3, bare));
  const span = Array.isArray(was) ? arraySpan(proText, "drc_exclusions") : null;
  if (span) {
    const lineStart = proText.lastIndexOf("\n", span.start) + 1;
    const indent = /^[ \t]*/.exec(proText.slice(lineStart))![0];
    const text = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
    const out = proText.slice(0, span.start) + text + proText.slice(span.end);
    const check = JSON.parse(out) as Json;
    if (JSON.stringify(((check["board"] as Json)["design_settings"] as Json)["drc_exclusions"]) === JSON.stringify(value)) return out;
  }
  ds["drc_exclusions"] = value;
  return JSON.stringify(pro, null, 2) + "\n";
}

/**
 * Apply what an edit changed in the exclusions (`from` -> `to`, both as read from the project and the candidate) to a
 * project file that may have been re-saved since in another form (a KiCad 10.99 save turns v2 entries into v3): entries
 * whose key the edit dropped go, the edit's new ones are added, every other entry stays exactly as the file holds it.
 */
export function withExclusionChanges(proText: string, from: readonly Exclusion[], to: readonly Exclusion[]): string {
  const same = (a: Exclusion, b: Exclusion) => a.key === b.key && a.comment === b.comment;
  const dropped = new Set(from.filter((f) => !to.some((t) => same(f, t))).map((f) => f.key));
  const added = to.filter((t) => !from.some((f) => same(f, t)));
  const now = readDrcExclusions(proText) ?? [];
  return withDrcExclusions(proText, [...now.filter((e) => !dropped.has(e.key) && !added.some((a) => same(a, e))), ...added.map(({ key, comment }) => ({ key, comment }))]);
}

/** Span of the array value of the only `"key": [` in a JSON text (strings skipped); null when absent or ambiguous. */
function arraySpan(text: string, key: string): Span | null {
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`, "g");
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) return null;
  const open = hits[0]!.index! + hits[0]![0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return { start: open, end: i + 1 };
  }
  return null;
}

/** A stable digest input for the exclusions (what adopt compares): keys and comments, whatever the storage form. */
export const exclusionsText = (entries: readonly Exclusion[] | null) => JSON.stringify((entries ?? []).map((e) => [e.key, e.comment]));

// ---------------------------------------------------------------------------------------------
// Board items by uuid

interface FpRec {
  uuid: string;
  ref: string;
  lib: string;
  x: number;
  y: number;
  rot: number;
  side: "F" | "B";
}

interface ItemRec {
  /** Owning footprint's uuid (the footprint itself, or one of its pads). */
  fp: string | null;
  /** "footprint", "pad:<number>", "fpitem" (other footprint child), or the top-level kind ("segment", "via" ...). */
  role: string;
  /** Top-level items only: the block, whitespace-collapsed, to tell whether the edit changed it. */
  block?: string;
}

export interface ItemIndex {
  fps: Map<string, FpRec>;
  items: Map<string, ItemRec>;
}

const OWN_UUID = new RegExp(`^\\(uuid\\s+"?(${UUID_RE})"?\\s*\\)$`);
const ownUuid = (text: string, kids: Span[]): string | null => {
  for (const k of kids) {
    if (!text.startsWith("(uuid", k.start)) continue;
    const m = OWN_UUID.exec(text.slice(k.start, k.end));
    if (m) return m[1]!.toLowerCase();
  }
  return null;
};
const headOf = (text: string, s: Span) => /^\(([A-Za-z_0-9]+)/.exec(text.slice(s.start, Math.min(s.end, s.start + 40)))?.[1] ?? "";

/** Every uuid-carrying item of the board: footprints (with pose and footprint id), their pads and children, top-level items. */
export function itemIndex(text: string): ItemIndex {
  const fps = new Map<string, FpRec>();
  const items = new Map<string, ItemRec>();
  const open = text.indexOf("(");
  if (open < 0) return { fps, items };
  for (const s of childLists(text, listSpanAt(text, open))) {
    const head = headOf(text, s);
    const kids = childLists(text, s);
    const uuid = ownUuid(text, kids);
    if (!uuid) continue;
    if (head !== "footprint") {
      items.set(uuid, { fp: null, role: head, block: text.slice(s.start, s.end).replace(/\s+/g, " ") });
      continue;
    }
    const body = text.slice(s.start, s.end);
    let p: [number, number, number];
    try {
      p = pose(body);
    } catch {
      continue;
    }
    const lib = /^\(footprint\s+"([^"]*)"/.exec(body)?.[1] ?? "";
    fps.set(uuid, { uuid, ref: refOf(body) ?? "?", lib, x: p[0], y: p[1], rot: ((p[2] % 360) + 360) % 360, side: sideOf(body) });
    items.set(uuid, { fp: uuid, role: "footprint" });
    for (const k of kids) {
      const kh = headOf(text, k);
      if (kh === "uuid") continue;
      const grand = childLists(text, k);
      const ku = ownUuid(text, grand);
      if (!ku) continue;
      const number = kh === "pad" ? /^\(pad\s+"([^"]*)"/.exec(text.slice(k.start, k.start + 200))?.[1] : undefined;
      items.set(ku, { fp: uuid, role: kh === "pad" ? `pad:${number ?? "?"}` : "fpitem" });
    }
  }
  return { fps, items };
}

// ---------------------------------------------------------------------------------------------
// Carrying

export interface DrcViolation {
  type?: string;
  excluded?: boolean;
  items?: Array<{ uuid?: string; description?: string }>;
}

export interface CarriedExclusion {
  rule: string;
  /** "moved together" or "replaced". */
  how: "moved together" | "replaced";
  from: string;
  to: string;
  /** One line for the edit's output: rule, items' refs, old -> new. */
  line: string;
  /** The violation (rule and unordered uuids) the new key is for: gone after the re-score when KiCad matched it. */
  violation: string;
}

export interface CarryResult {
  entries: Exclusion[];
  carried: CarriedExclusion[];
  /** Stale exclusions that correspond to a new violation but are not carried (and why). */
  notes: string[];
}

const EPS_MM = 0.001;
const samePose = (a: { x: number; y: number; rot: number }, b: { x: number; y: number; rot: number }) =>
  Math.abs(a.x - b.x) <= EPS_MM && Math.abs(a.y - b.y) <= EPS_MM && angleEq(a.rot, b.rot);
const angleEq = (a: number, b: number) => {
  const d = (((a - b) % 360) + 360) % 360;
  return d < 1e-6 || 360 - d < 1e-6;
};
const uuidsOf = (v: DrcViolation) => (v.items ?? []).map((i) => (i.uuid ?? "").toLowerCase()).filter(Boolean);
/** Rule and unordered item uuids: how a violation is recognised across two DRC runs. */
export const violationId = (v: DrcViolation) => `${v.type ?? "?"}|${[...uuidsOf(v)].sort().join("|")}`;
const mm = (nm: number) => (nm / 1e6).toFixed(4).replace(/\.?0+$/, "");

/** KiCad rotation (degrees, y down): a local vector turned by `deg`, as footprint pads are placed. */
function rotate(vx: number, vy: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  let c = Math.cos(r);
  let s = Math.sin(r);
  if (Math.abs(c - Math.round(c)) < 1e-12) c = Math.round(c);
  if (Math.abs(s - Math.round(s)) < 1e-12) s = Math.round(s);
  return [vx * c + vy * s, -vx * s + vy * c];
}

/**
 * Re-key the source's exclusions that the edit made stale, for the candidate's new violations. `exclusions` are the
 * project's (the candidate's `.kicad_pro` before carrying); violations are the DRC JSON entries (excluded ones ignored).
 */
export function carryExclusions(input: {
  exclusions: readonly Exclusion[];
  source: string;
  after: string;
  sourceViolations: readonly DrcViolation[];
  afterViolations: readonly DrcViolation[];
  editId: string;
}): CarryResult {
  const entries = input.exclusions.map((e) => ({ ...e }));
  const carried: CarriedExclusion[] = [];
  const notes: string[] = [];
  const live = (l: readonly DrcViolation[]) => l.filter((v) => !v.excluded);
  const before = new Set(live(input.sourceViolations).map(violationId));
  const fresh = live(input.afterViolations).filter((v) => !before.has(violationId(v)) && [1, 2].includes(uuidsOf(v).length));
  if (!fresh.length || !entries.length) return { entries, carried, notes };
  const src = itemIndex(input.source);
  const aft = itemIndex(input.after);
  const fpMoved = (u: string) => {
    const a = src.fps.get(u), b = aft.fps.get(u);
    return !a || !b || !samePose(a, b) || a.side !== b.side;
  };
  /** The item is where it was: its footprint did not move, or (top-level) its block is unchanged. */
  const unchanged = (u: string) => {
    const a = src.items.get(u), b = aft.items.get(u);
    if (!a || !b) return false;
    if (a.fp) return a.fp === b.fp && !fpMoved(a.fp);
    return a.block === b.block;
  };
  const refOfItem = (idx: ItemIndex, u: string) => {
    if (u === NIL_UUID) return null;
    const it = idx.items.get(u);
    if (!it) return u.slice(0, 8);
    if (!it.fp) return it.role;
    const ref = idx.fps.get(it.fp)?.ref ?? "?";
    return it.role.startsWith("pad:") ? `${ref}.${it.role.slice(4)}` : ref;
  };
  const describe = (idx: ItemIndex, k: ExclusionKey) => `${[refOfItem(idx, k.a), refOfItem(idx, k.b)].filter(Boolean).join(" + ")} at (${mm(k.x)}, ${mm(k.y)})`;
  const stamp = (comment: string) => `${comment.replace(/\s*\[carried by edit [^\]]*\]$/, "")}${comment ? " " : ""}[carried by edit ${input.editId}]`;
  const parsed = entries.map((e) => parseExclusionKey(e.key));
  const used = new Set<number>();
  // stale: an exclusion whose items the edit moved, removed or changed (one left alone still matches as before)
  const stale = parsed.map((k) => {
    if (!k) return false;
    for (const u of [k.a, k.b]) {
      if (u === NIL_UUID) continue;
      if (!src.items.has(u)) return false; // already stale in the source: not ours to revive
      if (!unchanged(u)) return true;
    }
    return false;
  });
  for (const v of fresh) {
    const vu = uuidsOf(v);
    const pair = (vu.length === 1 ? [vu[0]!, NIL_UUID] : vu).slice().sort().join("|");
    const newKey = (x: number, y: number): ExclusionKey => ({ rule: v.type!, x, y, a: vu[0]!, b: vu[1] ?? NIL_UUID });
    let done = false;
    // (a) the same items, moved together by one rigid motion
    for (let i = 0; i < entries.length && !done; i++) {
      const k = parsed[i];
      if (!k || used.has(i) || !stale[i] || k.rule !== v.type || [k.a, k.b].sort().join("|") !== pair) continue;
      const owners = [...new Set([k.a, k.b].filter((u) => u !== NIL_UUID).map((u) => src.items.get(u)?.fp ?? null))];
      const motion = owners.every((f) => f !== null) ? rigidMotion(owners as string[], src, aft) : null;
      if (!motion) {
        notes.push(`not carried: ${k.rule} exclusion for ${describe(src, k)}: the same items fail again, but their parts did not move together, so KiCad places the marker anew; if it is still intended, exclude it again in KiCad`);
        used.add(i);
        done = true;
        break;
      }
      const [x, y] = motion(k.x, k.y);
      const nk = newKey(x, y);
      carried.push({ rule: k.rule, how: "moved together", from: entries[i]!.key, to: exclusionKey(nk), violation: violationId(v), line: `${k.rule} ${describe(src, k)} -> ${describe(aft, nk)} (moved together)` });
      entries[i] = { key: exclusionKey(nk), comment: stamp(entries[i]!.comment) };
      used.add(i);
      done = true;
    }
    if (done || vu.length !== 2) continue;
    // (b) one item the same, the other now a footprint of the same id at the old owner's pose
    for (let i = 0; i < entries.length && !done; i++) {
      const k = parsed[i];
      if (!k || used.has(i) || !stale[i] || k.rule !== v.type || k.b === NIL_UUID) continue;
      const shared = [k.a, k.b].filter((u) => vu.includes(u));
      if (shared.length !== 1) continue;
      const x = shared[0]!;
      const y = x === k.a ? k.b : k.a;
      const z = vu.find((u) => u !== x)!;
      if (!unchanged(x)) continue;
      const yi = src.items.get(y), zi = aft.items.get(z);
      if (!yi?.fp || !zi?.fp || yi.role !== zi.role || yi.role === "fpitem" || yi.fp === zi.fp) continue;
      const fy = src.fps.get(yi.fp)!, fz = aft.fps.get(zi.fp)!;
      const fzWas = src.fps.get(zi.fp);
      const fyNow = aft.fps.get(yi.fp);
      if (fz.lib !== fy.lib || fz.side !== fy.side || !samePose(fz, fy)) continue;
      if (fzWas && samePose(fzWas, fz)) continue; // the newcomer must have arrived in this edit
      if (fyNow && samePose(fyNow, fy)) continue; // and the old owner must have left
      const nk = newKey(k.x, k.y);
      carried.push({ rule: k.rule, how: "replaced", from: entries[i]!.key, to: exclusionKey(nk), violation: violationId(v), line: `${k.rule} ${describe(src, k)} -> ${describe(aft, nk)} (${fz.ref} took ${fy.ref}'s place)` });
      entries[i] = { key: exclusionKey(nk), comment: stamp(entries[i]!.comment) };
      used.add(i);
      done = true;
    }
  }
  return { entries, carried, notes };
}

/**
 * The one rigid motion (rotation delta, then translation; same side) that took every footprint in `owners` from its
 * source pose to its candidate pose, as a map of nm positions; null when they did not all move by the same motion.
 */
function rigidMotion(owners: string[], src: ItemIndex, aft: ItemIndex): ((x: number, y: number) => [number, number]) | null {
  const poses = owners.map((u) => [src.fps.get(u), aft.fps.get(u)] as const);
  if (poses.some(([a, b]) => !a || !b || a.side !== b.side)) return null;
  const [a0, b0] = poses[0]! as readonly [FpRec, FpRec];
  const delta = b0.rot - a0.rot;
  if (samePose(a0, b0)) return null; // nothing moved: the exclusion would not be stale
  const map = (x: number, y: number): [number, number] => {
    const [dx, dy] = rotate(x - a0.x, y - a0.y, delta);
    return [b0.x + dx, b0.y + dy];
  };
  for (const [a, b] of poses.slice(1) as Array<readonly [FpRec, FpRec]>) {
    if (!angleEq(b.rot - a.rot, delta)) return null;
    const [mx, my] = map(a.x, a.y);
    if (Math.abs(mx - b.x) > EPS_MM || Math.abs(my - b.y) > EPS_MM) return null;
  }
  // in integer nm, as KiCad holds the marker (exact for quarter turns)
  const nm = (v: number) => Math.round(v * 1e6);
  return (xNm, yNm) => {
    const [dx, dy] = rotate(xNm - nm(a0.x), yNm - nm(a0.y), delta);
    return [Math.round(nm(b0.x) + dx), Math.round(nm(b0.y) + dy)];
  };
}
