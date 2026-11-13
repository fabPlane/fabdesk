/** The ECO plan: what the agent writes. Poses and nets are the plan's; everything else is computed. */
import type { DisplaceSpec, MoveSpec } from "./move";

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

export interface EditPlan {
  id: string;
  authority?: string;
  reason?: string;
  /** Parts to delete (with their symbols and copper). */
  remove?: string[];
  move?: MoveSpec[];
  displace?: DisplaceSpec;
  swap?: SwapSpec[];
  add?: AddSpec[];
  net?: NetSpec[];
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
  strList(plan.remove, "remove");
  strList(plan.accept_unconnected, "accept_unconnected");
  for (const m of plan.move ?? []) {
    if (!isObj(m) || typeof m.ref !== "string") throw new Error("plan.move entries need a ref");
    if (m.to === undefined && m.near === undefined) throw new Error(`move ${m.ref}: give "to": [x, y, rotation] or "near"`);
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
