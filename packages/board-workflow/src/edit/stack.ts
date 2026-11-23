/**
 * A supplier-stack / rule plan applied to a candidate (the toolkit's `flow/stack_plan.py`, line for line): class
 * updates, classes split off for named nets or pairs, an acceptance merge and named key removals in acceptance.json,
 * dielectric epsilon_r in the board's stackup, named via removals (each with its engineering reason), and optionally
 * the whole board taken from another file (`copper_source`, a bench result). Circuit and poses are kept; route repairs
 * are bench steps, never coordinates in this plan.
 */
import { kid, parseSexpr, topLevelSpans } from "../sexpr";
import { EditStop } from "./sch";

export interface StackSpec {
  /** Class name -> keys merged into that acceptance class (nested objects merge). */
  classes?: Record<string, Record<string, unknown>>;
  /** New class -> {from, nets | pairs, updates}: a copy of `from` holding just these nets (or pairs), which `from` loses. */
  split_classes?: Record<string, { from: string; nets?: string[]; pairs?: string[][]; updates: Record<string, unknown> }>;
  /** Merged into acceptance.json (nested objects merge), e.g. a `supplier_stack` record. */
  acceptance?: Record<string, unknown>;
  /** Dotted acceptance.json paths removed after the merge. */
  remove_acceptance_paths?: string[];
  /** Stackup layer name ("dielectric 1") -> {er}: its epsilon_r. */
  dielectrics?: Record<string, { er: number }>;
  /** A project board file whose copper (the whole file) replaces the board first: a bench result to adopt. */
  copper_source?: string;
  /** Vias removed by uuid and net, each with the engineering reason. */
  remove_vias?: Array<{ uuid: string; net: string; reason: string }>;
}

const fail = (m: string): never => {
  throw new EditStop(`FAIL stack: ${m}`);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** stack_plan.merge: nested objects merge, anything else replaces. */
export function merge(a: Obj, b: Obj): void {
  for (const [k, v] of Object.entries(b)) {
    if (isObj(v) && isObj(a[k])) merge(a[k] as Obj, v);
    else a[k] = clone(v);
  }
}

const samePair = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** The acceptance half of stack_plan.main, on `acc` (mutated). Returns the class names it changed or added. */
export function stackAcceptance(acc: Obj, spec: StackSpec): { updated: string[]; split: string[]; removed_paths: string[] } {
  const nc = acc["net_classes"];
  const classes = isObj(nc) && isObj(nc["classes"]) ? (nc["classes"] as Record<string, Obj>) : fail("acceptance.json has no net_classes.classes");
  for (const [n, updates] of Object.entries(spec.classes ?? {})) {
    if (!isObj(classes[n])) fail(`class ${n} is not in acceptance.json`);
    merge(classes[n]!, updates);
  }
  for (const [n, c] of Object.entries(spec.split_classes ?? {})) {
    const base = classes[c.from];
    if (!isObj(base)) return fail(`split_classes ${n}: class ${c.from} is not in acceptance.json`);
    const nw = clone(base);
    if ("pairs" in c) {
      if (!Array.isArray(base["pairs"])) fail(`split_classes ${n}: class ${c.from} has no pairs`);
      nw["pairs"] = clone(c.pairs);
      delete nw["nets"];
      base["pairs"] = (base["pairs"] as unknown[]).filter((x) => !(c.pairs ?? []).some((p) => samePair(p, x)));
    } else {
      if (!Array.isArray(base["nets"])) fail(`split_classes ${n}: class ${c.from} has no nets`);
      nw["nets"] = clone(c.nets);
      base["nets"] = (base["nets"] as unknown[]).filter((x) => !(c.nets ?? []).includes(x as string));
    }
    if (!isObj(c.updates)) fail(`split_classes ${n}: updates is required`);
    merge(nw, c.updates);
    classes[n] = nw;
  }
  merge(acc, spec.acceptance ?? {});
  for (const path of spec.remove_acceptance_paths ?? []) {
    const keys = path.split(".");
    let obj: unknown = acc;
    for (const key of keys.slice(0, -1)) {
      if (!isObj(obj) || !(key in obj)) return fail(`remove_acceptance_paths ${path}: ${key} is not there`);
      obj = obj[key];
    }
    if (isObj(obj)) delete obj[keys[keys.length - 1]!];
  }
  return { updated: Object.keys(spec.classes ?? {}), split: Object.keys(spec.split_classes ?? {}), removed_paths: spec.remove_acceptance_paths ?? [] };
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The board half of stack_plan.main (after any copper_source copy): named via removals, then dielectric epsilon_r. */
export function stackBoard(text: string, spec: StackSpec): { text: string; removed_vias: Array<{ uuid: string; net: string; reason: string }> } {
  for (const item of spec.remove_vias ?? []) {
    if (!item.reason) fail("via cleanup needs an engineering reason");
    const m = topLevelSpans(text, "via").filter((s) => {
      const b = text.slice(s.start, s.end);
      return b.includes(`(uuid "${item.uuid}")`) && b.includes(`(net "${item.net}")`);
    });
    if (m.length !== 1) fail(`via identity is not unique: ${JSON.stringify(item)} (${m.length} matches)`);
    text = text.slice(0, m[0]!.start) + text.slice(m[0]!.end);
  }
  for (const [key, material] of Object.entries(spec.dielectrics ?? {})) {
    const re = new RegExp(`(\\(layer "${reEsc(key)}"[\\s\\S]*?\\(epsilon_r )([\\d.]+)(\\))`);
    const m = re.exec(text);
    if (!m) return fail(`missing dielectric ${key}`);
    text = text.slice(0, m.index) + m[1]! + String(material.er) + m[3]! + text.slice(m.index + m[0].length);
  }
  return { text, removed_vias: spec.remove_vias ?? [] };
}

/** Nets whose copper a stack plan's own via removals touch. */
export const stackViaNets = (spec: StackSpec): string[] => [...new Set((spec.remove_vias ?? []).map((v) => v.net))].sort();

/** The board's stackup list text, when it has one (`(setup ... (stackup ...))`). */
export function stackupText(text: string): string | null {
  const setup = topLevelSpans(text, "setup")[0];
  if (!setup) return null;
  const body = text.slice(setup.start, setup.end);
  const i = body.search(/\(stackup[\s)]/);
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < body.length; j++) {
    const ch = body[j]!;
    if (inStr) {
      if (ch === "\\") j++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return body.slice(i, j + 1);
  }
  return null;
}

/** `text` with its stackup list replaced by `stackup` (a no-op when either has none). */
export function withStackup(text: string, stackup: string): string {
  const cur = stackupText(text);
  if (cur === null) return text;
  const setup = topLevelSpans(text, "setup")[0]!;
  const at = text.indexOf(cur, setup.start);
  return text.slice(0, at) + stackup + text.slice(at + cur.length);
}

/** Dielectric epsilon_r per stackup layer (for the impact report). */
export function dielectricsOf(text: string): Record<string, string> {
  const s = stackupText(text);
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const l of parseSexpr(s).slice(1)) {
    if (!Array.isArray(l) || l[0] !== "layer") continue;
    const e = kid(l, "epsilon_r");
    if (e) out[String(l[1])] = String(e[1]);
  }
  return out;
}
