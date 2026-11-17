/** The ECO plan: what the agent writes. Poses and nets are the plan's; everything else is computed. */
import type { CopperSpec } from "./copper";
import type { HoleSpec } from "./hole";
import type { DisplaceSpec, MoveSpec } from "./move";
import type { StackSpec } from "./stack";

export interface SwapSpec {
  ref: string;
  value?: string;
  fields?: Record<string, string>;
  /** `LIB:NAME`: rebuild the footprint (pose and pad-number -> net map kept). */
  footprint?: string;
  /** Flip to this side while swapping. */
  side?: "F" | "B";
  /** Fit / do-not-fit. */
  dnp?: boolean;
  height_mm?: number;
  height_basis?: string;
}

export interface AddSpec {
  ref: string;
  /** Template symbol on the schematic (gives the sheet, instance path and field layout) and the footprint/value defaults. */
  like: string;
  value?: string;
  footprint?: string;
  /** Pad number -> net. */
  pins: Record<string, string>;
  /** A part, a `REF.PAD`, or a point. Default: next to `like`. */
  near?: string | [number, number];
  /** With `near: "REF.PAD"`: a direct track from this part's pad on that pad's net to it (default true; false leaves the connection to pours and the last mile). */
  link?: boolean;
  side?: "F" | "B";
  rot?: number;
  fields?: Record<string, string>;
  /** `LIB:NAME` from the project's symbol library instead of `like`'s symbol. */
  symbol?: string;
  radius?: number;
  rotations?: "keep" | "any";
  height_mm?: number;
  height_basis?: string;
  basis?: string;
}

export interface NetSpec {
  /** `REF.PAD`. */
  pin: string;
  to: string;
  tap_width?: number;
  tap_basis?: string;
}

export interface LegaliseSpec {
  refs: string[];
  /** Courtyard clearance to other parts and drilled pads, mm (default 0.15, as tp_legalise). */
  clearance?: number;
  /** Margin from the board outline, mm (default 0.5). */
  edge?: number;
  /** Search radius round the net centroid, mm (default 40). */
  radius?: number;
}

/** `legalise` as `move` entries whose pose tp_legalise's search computes (rotation kept); a ref the plan already moves is left to its own move. */
export function legaliseMoves(spec: string[] | LegaliseSpec, already: ReadonlySet<string> = new Set()): MoveSpec[] {
  const s: LegaliseSpec = Array.isArray(spec) ? { refs: spec } : spec;
  return s.refs
    .filter((r) => !already.has(r))
    .map((ref) => ({
      ref,
      legalise: { clearance: s.clearance ?? 0.15, edge: s.edge ?? 0.5, radius: s.radius ?? 40 },
      basis: "legalise (tp_legalise): nearest free spot to the centroid of its net's other pads",
    }));
}

export interface EditPlan {
  /** Explicit permission to deliver tracks narrower than the pre-edit baseline. */
  allow_narrowing?: boolean;
  id: string;
  authority?: string;
  reason?: string;
  /** Parts to delete (with their symbols and copper). */
  remove?: string[];
  move?: MoveSpec[];
  displace?: DisplaceSpec;
  /**
   * Test points (and any part whose pads are on one net) to re-seat at the nearest free spot to the centroid of the
   * other pads on their net: courtyard and drilled pads clear by `clearance`, the outline by `edge`, rotation and side
   * kept (the toolkit's tools/tp_legalise.py, its own search, in the order given). Each becomes a `move` to that pose.
   */
  legalise?: string[] | LegaliseSpec;
  swap?: SwapSpec[];
  add?: AddSpec[];
  net?: NetSpec[];
  /**
   * Local copper support edits (the toolkit's flow/copper_plan.py), after any moves: filled/capped F-B vias at saved pad
   * centres, leaf pruning of named nets, copper items removed by uuid, a source-board sha256 guard. Never routes.
   */
  copper?: CopperSpec;
  /** Resize a named unnetted NPTH locating hole with its courtyards, keep-out and project library footprint (flow/mechanical_hole.py). */
  hole?: HoleSpec;
  /** A supplier-stack / rule plan (flow/stack_plan.py): acceptance classes and keys, dielectric epsilon_r, named via removals, copper_source. */
  stack?: StackSpec;
  /** Pins left on single-pad nets, reviewed (impact lists them). */
  accept_unconnected?: string[];
  /** Checks that already fail on the source, with the reason: the judgement is then "no new failure". */
  accept_before?: Record<string, string>;
  notes?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strList = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`plan.${what} must be a list of strings`);
  return v as string[];
};

/** Validate a plan read from JSON; returns a deep copy (the pipeline fills in `carry` on its moves). */
export function parsePlan(raw: unknown): EditPlan {
  if (!isObj(raw)) throw new Error("plan must be a JSON object");
  const plan = JSON.parse(JSON.stringify(raw)) as EditPlan;
  if (typeof plan.id !== "string" || !/^[\w.-]+$/.test(plan.id)) throw new Error("plan.id is required (letters, digits, - _ .)");
  if (plan.allow_narrowing !== undefined && typeof plan.allow_narrowing !== "boolean") throw new Error("plan.allow_narrowing must be boolean");
  strList(plan.remove, "remove");
  strList(plan.accept_unconnected, "accept_unconnected");
  if (plan.legalise !== undefined) {
    const l = plan.legalise;
    const refs = Array.isArray(l) ? l : isObj(l) ? (l as LegaliseSpec).refs : undefined;
    if (!Array.isArray(refs) || !refs.length || refs.some((x) => typeof x !== "string"))
      throw new Error('plan.legalise is a list of references, or {"refs": [...], "clearance", "edge", "radius"}');
    const moved = new Set((plan.move ?? []).map((m) => (isObj(m) ? String(m.ref) : "")));
    plan.move = [...(plan.move ?? []), ...legaliseMoves(l, moved)];
  }
  for (const m of plan.move ?? []) {
    if (!isObj(m) || typeof m.ref !== "string") throw new Error("plan.move entries need a ref");
    if (m.to === undefined && m.near === undefined && m.legalise === undefined) throw new Error(`move ${m.ref}: give "to": [x, y, rotation] or "near"`);
    // carry_auto: true means this move's own part (an agent wrote it so; spreading the boolean crashed the edit child)
    const ca = (m as { carry_auto?: unknown }).carry_auto;
    if (ca === true) m.carry_auto = [m.ref];
    else if (ca === false || ca === null) delete m.carry_auto;
    else if (ca !== undefined && (!Array.isArray(ca) || ca.some((x) => typeof x !== "string")))
      throw new Error(`move ${m.ref}: "carry_auto" is a list of references (or true for this part)`);
    const cr = (m as { carry?: unknown }).carry;
    if (cr !== undefined && (!Array.isArray(cr) || cr.some((x) => typeof x !== "string"))) throw new Error(`move ${m.ref}: "carry" is a list of references`);
    if (m.to !== undefined && (!Array.isArray(m.to) || m.to.length !== 3 || m.to.some((v) => typeof v !== "number")))
      throw new Error(`move ${m.ref}: "to" is [x, y, rotation]`);
  }
  for (const s of plan.swap ?? []) if (!isObj(s) || typeof s.ref !== "string") throw new Error("plan.swap entries need a ref");
  for (const a of plan.add ?? []) {
    if (!isObj(a) || typeof a.ref !== "string" || typeof a.like !== "string" || !isObj(a.pins)) throw new Error("plan.add entries need ref, like and pins");
  }
  for (const n of plan.net ?? []) {
    if (!isObj(n) || typeof n.pin !== "string" || !/^[^.]+\..+$/.test(n.pin) || typeof n.to !== "string") throw new Error('plan.net entries are {"pin": "REF.PAD", "to": "NET"}');
  }
  if (plan.copper !== undefined) {
    const c = plan.copper as unknown;
    if (!isObj(c)) throw new Error("plan.copper is an object: {via_at_pad, prune_signal_leaves, prune_track_leaves, remove_items, source_sha256}");
    for (const v of (c["via_at_pad"] ?? []) as unknown[])
      if (!isObj(v) || typeof v["ref"] !== "string" || (typeof v["pad"] !== "string" && typeof v["pad"] !== "number") || typeof v["diameter"] !== "number" || typeof v["drill"] !== "number")
        throw new Error('plan.copper.via_at_pad entries are {"ref", "pad", "diameter", "drill"}');
    strList(c["prune_signal_leaves"], "copper.prune_signal_leaves");
    strList(c["prune_track_leaves"], "copper.prune_track_leaves");
    strList(c["remove_items"], "copper.remove_items");
    if (c["source_sha256"] !== undefined && (typeof c["source_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(c["source_sha256"]))) throw new Error("plan.copper.source_sha256 is a sha256 hex digest");
  }
  if (plan.hole !== undefined) {
    const h = plan.hole as unknown;
    if (!isObj(h) || typeof h["ref"] !== "string" || !Array.isArray(h["size_mm"]) || h["size_mm"].length !== 2 || h["size_mm"].some((v) => typeof v !== "number" || !(v > 0 && v < 10)))
      throw new Error('plan.hole is {"ref", "size_mm": [X, Y] (0 < X, Y < 10 mm), "clearance_mm"}');
    if (h["clearance_mm"] !== undefined && (typeof h["clearance_mm"] !== "number" || h["clearance_mm"] < 0)) throw new Error("plan.hole.clearance_mm is a number >= 0");
  }
  if (plan.stack !== undefined) {
    const s = plan.stack as unknown;
    if (!isObj(s)) throw new Error("plan.stack is an object");
    for (const k of ["classes", "split_classes", "acceptance", "dielectrics"]) if (s[k] !== undefined && !isObj(s[k])) throw new Error(`plan.stack.${k} is an object`);
    for (const [n, c] of Object.entries((s["split_classes"] ?? {}) as Record<string, unknown>))
      if (!isObj(c) || typeof c["from"] !== "string" || !isObj(c["updates"]) || (c["nets"] === undefined) === (c["pairs"] === undefined))
        throw new Error(`plan.stack.split_classes.${n} is {"from", "nets" | "pairs", "updates"}`);
    for (const [n, d] of Object.entries((s["dielectrics"] ?? {}) as Record<string, unknown>))
      if (!isObj(d) || typeof d["er"] !== "number") throw new Error(`plan.stack.dielectrics["${n}"] is {"er": number}`);
    strList(s["remove_acceptance_paths"], "stack.remove_acceptance_paths");
    for (const v of (s["remove_vias"] ?? []) as unknown[])
      if (!isObj(v) || typeof v["uuid"] !== "string" || typeof v["net"] !== "string") throw new Error('plan.stack.remove_vias entries are {"uuid", "net", "reason"}');
    if (s["copper_source"] !== undefined) {
      if (typeof s["copper_source"] !== "string" || !s["copper_source"].endsWith(".kicad_pcb")) throw new Error("plan.stack.copper_source is a project-relative .kicad_pcb");
      const others = (["remove", "move", "legalise", "swap", "add", "net", "copper", "hole"] as const).filter((k) => plan[k] !== undefined);
      if (others.length) throw new Error(`plan.stack.copper_source replaces the whole board: give it in a plan of its own (this plan also has ${others.join(", ")})`);
    }
  }
  return plan;
}

/** Numeric poses the plan's author wrote (the benchmark counts them: a computed move writes none). */
export function coordinatesInPlan(plan: EditPlan): number {
  let n = 0;
  for (const m of plan.move ?? []) n += (Array.isArray(m.to) ? 1 : 0) + (Array.isArray(m.near) ? 1 : 0);
  for (const a of plan.add ?? []) n += Array.isArray(a.near) ? 1 : 0;
  return n;
}

export const splitPin = (pin: string): [string, string] => {
  const i = pin.lastIndexOf(".");
  return [pin.slice(0, i), pin.slice(i + 1)];
};
