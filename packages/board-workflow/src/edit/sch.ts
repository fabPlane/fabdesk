/**
 * Schematic edits for ECO: find a symbol, set its fields and flags, move a pin to another net (label), add a symbol
 * with one global label per pin, remove the labels and wires that hung on a deleted symbol's pins. Every edit is a
 * splice on the sheet's text (see `splice` in sexpr): bytes that are not edited are never rewritten.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appendRaw } from "./text";
import { g, round } from "./fmt";
import { listSpanAt, removeSpans, topLevelSpans, type Span } from "../sexpr";

export class EditStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditStop";
  }
}
export const stop = (m: string): never => {
  throw new EditStop(m);
};

type Pt = [number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** The top-level `.kicad_sch` sheets of a project folder, held in memory and written back only where they changed. */
export class SheetSet {
  readonly texts = new Map<string, string>();
  private readonly original = new Map<string, string>();
  constructor(readonly dir: string) {
    for (const n of readdirSync(dir).filter((f) => f.endsWith(".kicad_sch") && !f.startsWith("_autosave")).sort()) {
      const t = readFileSync(join(dir, n), "utf8");
      this.texts.set(n, t);
      this.original.set(n, t);
    }
  }
  get names(): string[] {
    return [...this.texts.keys()];
  }
  changed(): string[] {
    return this.names.filter((n) => this.texts.get(n) !== this.original.get(n));
  }
  flush(): string[] {
    const ch = this.changed();
    for (const n of ch) writeFileSync(join(this.dir, n), this.texts.get(n)!);
    return ch;
  }
  set(name: string, text: string) {
    this.texts.set(name, text);
  }
  /** The placed symbol with reference `ref` (not a lib_symbols entry). */
  symbol(ref: string): { name: string; span: Span } | null {
    for (const [name, t] of this.texts) {
      for (const span of topLevelSpans(t, "symbol")) {
        const blk = t.slice(span.start, span.end);
        if (blk.includes(`(property "Reference" "${ref}"`) && t.slice(span.start, span.start + 200).includes("(lib_id")) return { name, span };
      }
    }
    return null;
  }
  /** Sheets that instantiate `ref` in a `(reference "REF")` instance entry (a sheet used several times). */
  instancedIn(ref: string): string[] {
    return this.names.filter((n) => this.texts.get(n)!.includes(`(reference "${ref}")`));
  }
}

const propRe = (k: string) => new RegExp(`\\(property "${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" "((?:[^"\\\\]|\\\\.)*)"`);

export function setSymProps(sheets: SheetSet, ref: string, props: Record<string, string>): string {
  const sym = sheets.symbol(ref);
  if (!sym) return stop(`FAIL schematic symbol ${ref} not found in ${sheets.dir}`);
  const t = sheets.texts.get(sym.name)!;
  let b = t.slice(sym.span.start, sym.span.end);
  for (const [k, v] of Object.entries(props)) {
    const m = propRe(k).exec(b);
    if (m) {
      const i = m.index + m[0].length - m[1]!.length - 1;
      b = b.slice(0, i) + esc(v) + b.slice(i + m[1]!.length);
    } else {
      const at = /\(at ([-\d.]+) ([-\d.]+)/.exec(b)!;
      // after the properties: before the first (pin ...) or, in sheets whose symbols list no pins, before (instances ...);
      // in the file's own indentation (KiCad 9 writes spaces, 10 tabs)
      const anchor = /\n([ \t]*)\((?:pin |instances)/.exec(b);
      if (!anchor) return stop(`FAIL ${ref}: no place to add property ${k} in ${sym.name}`);
      const ind = anchor[1]!;
      const unit = ind.includes("\t") ? "\t" : "  ";
      const ins = `\n${ind}(property "${k}" "${esc(v)}"\n${ind}${unit}(at ${at[1]} ${at[2]} 0)\n${ind}${unit}(effects\n${ind}${unit}${unit}(font\n${ind}${unit}${unit}${unit}(size 1 1))\n${ind}${unit}${unit}(hide yes)))`;
      b = b.slice(0, anchor.index) + ins + b.slice(anchor.index);
    }
  }
  sheets.set(sym.name, t.slice(0, sym.span.start) + b + t.slice(sym.span.end));
  return sym.name;
}

/** Symbol-level flags such as { in_bom: "no", dnp: "yes" } (parity compares them with the footprint's attributes). */
export function setSymFlags(sheets: SheetSet, ref: string, flags: Record<string, string>): string {
  const sym = sheets.symbol(ref);
  if (!sym) return stop(`FAIL schematic symbol ${ref} not found in ${sheets.dir}`);
  const t = sheets.texts.get(sym.name)!;
  const headEnd = t.indexOf("(property ", sym.span.start);
  let head = t.slice(sym.span.start, headEnd);
  for (const [k, v] of Object.entries(flags)) {
    const re = new RegExp(`\\(${k} (yes|no)\\)`);
    if (re.test(head)) head = head.replace(re, `(${k} ${v})`);
    else head = head.replace("(uuid ", () => `(${k} ${v})\n    (uuid `);
  }
  sheets.set(sym.name, t.slice(0, sym.span.start) + head + t.slice(headEnd));
  return sym.name;
}

/** Symbol flags implied by a footprint's (attr ...) node. */
export function fpAttrFlags(fpText: string): { in_bom: string; dnp: string } {
  const m = /\(attr ([^)]*)\)/.exec(fpText);
  const words = new Set(m ? m[1]!.trim().split(/\s+/) : []);
  return { in_bom: words.has("exclude_from_bom") ? "no" : "yes", dnp: words.has("dnp") ? "yes" : "no" };
}

/** Pin number -> (x, y) connection point in symbol coordinates, from the sheet's lib_symbols cache. */
export function libPins(t: string, libId: string): Map<string, Pt> {
  const i = t.indexOf(`(symbol "${libId}"`, Math.max(0, t.indexOf("(lib_symbols")));
  if (i < 0) return stop(`FAIL lib symbol ${libId} not cached in the schematic`);
  const blk = t.slice(i, listSpanAt(t, i).end);
  const out = new Map<string, Pt>();
  for (const m of blk.matchAll(/\(pin \w+ \w+\s*\(at ([-\d.]+) ([-\d.]+)(?: [-\d.]+)?\)([\s\S]*?)\(number "([^"]+)"/g)) out.set(m[4]!, [Number(m[1]), Number(m[2])]);
  return out;
}

export function pinTip(t: string, symBlock: string, pin: string): Pt {
  const libId = /\(lib_id "([^"]+)"\)/.exec(symBlock)![1]!;
  const at = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(symBlock)!;
  const X = Number(at[1]), Y = Number(at[2]), a = Number(at[3] ?? 0);
  const p = libPins(t, libId).get(pin);
  if (!p) return stop(`FAIL pin ${pin} not on lib symbol ${libId}`);
  let [px, py] = p;
  const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
  const mirror = /\(mirror (\w)\)/.exec(symBlock.slice(0, 600));
  if (mirror?.[1] === "y") px = -px;
  if (mirror?.[1] === "x") py = -py;
  // symbol coordinates are Y-up; the sheet is Y-down; rotation is counter-clockwise on the sheet
  return [round(X + (px * c - py * s), 4), round(Y - (px * s + py * c), 4)];
}

const globalLabel = (net: string, x: number, y: number, angle: number, justify: boolean) =>
  `\n  (global_label "${esc(net)}"\n    (shape passive)\n    (at ${g(x)} ${g(y)} ${angle})\n    (effects\n      (font\n        (size 1 1))${justify ? "\n      (justify left))" : ")"}\n    (uuid "${randomUUID()}")\n    (property "Intersheetrefs" "\${INTERSHEET_REFS}"\n      (at ${g(x)} ${g(y)} 0)\n      (effects\n        (font\n          (size 1 1))\n        (hide yes))))`;

const AT = /\(at ([-\d.]+) ([-\d.]+)/;
const atOf = (blk: string): Pt | null => {
  const m = AT.exec(blk);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const XY = /\(xy ([-\d.]+) ([-\d.]+)\)/g;
const wirePts = (blk: string): Pt[] => [...blk.matchAll(XY)].map((m) => [Number(m[1]), Number(m[2])]);

function segDist(pt: Pt, a: Pt, b: Pt): number {
  const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / L2));
  return dist(pt, [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])]);
}

/**
 * Put pin `pin` of `ref` on net `newNet` in the schematic: rename the label at its tip (following wires), or, when the
 * pin is wired into a shared net, detach its own leg and label it, or replace a no-connect flag with a label.
 * Returns the sheet and what was there before.
 */
export function relabel(sheets: SheetSet, ref: string, pin: string, newNet: string): { sheet: string; was: string } {
  const sym = sheets.symbol(ref);
  if (!sym) return stop(`FAIL schematic symbol ${ref} not found in ${sheets.dir}`);
  let t = sheets.texts.get(sym.name)!;
  const tip = pinTip(t, t.slice(sym.span.start, sym.span.end), pin);
  const wires: Array<[Pt, Pt]> = [];
  for (const s of topLevelSpans(t, "wire")) {
    const pts = wirePts(t.slice(s.start, s.end));
    if (pts.length >= 2) wires.push([pts[0]!, pts[pts.length - 1]!]);
  }
  const reach: Pt[] = [tip];
  const frontier: Pt[] = [tip];
  const seen = (p: Pt) => reach.some((q) => q[0] === p[0] && q[1] === p[1]);
  while (frontier.length) {
    const q = frontier.pop()!;
    for (const [a, b] of wires)
      for (const [u, v] of [[a, b], [b, a]] as Array<[Pt, Pt]>)
        if (dist(u, q) < 0.01 && !seen(v)) {
          reach.push(v);
          frontier.push(v);
        }
  }
  const commit = (text: string) => sheets.set(sym.name, text);
  if (reach.length > 2) {
    // the pin is wired into a shared net: walk its own leg up to the first branch point and detach it
    const tips: Pt[] = [];
    for (const s of topLevelSpans(t, "symbol")) {
      const bb = t.slice(s.start, s.end);
      if (!bb.slice(0, 200).includes("(lib_id")) continue;
      const lid = /\(lib_id "([^"]+)"\)/.exec(bb)![1]!;
      try {
        for (const pn of libPins(t, lid).keys()) {
          const q = pinTip(t, bb, pn);
          if (!(dist(q, tip) < 0.01)) tips.push(q);
        }
      } catch (e) {
        if (!(e instanceof EditStop)) throw e;
      }
    }
    const juncs: Pt[] = topLevelSpans(t, "junction").flatMap((s) => {
      const a = atOf(t.slice(s.start, s.end));
      return a ? [a] : [];
    });
    const labelsAt: Pt[] = ["label", "global_label", "hierarchical_label"].flatMap((k) =>
      topLevelSpans(t, k).flatMap((s) => {
        const a = atOf(t.slice(s.start, s.end));
        return a ? [a] : [];
      }),
    );
    const special = [...juncs, ...tips, ...labelsAt];
    const touching = (q: Pt, skip: Array<[Pt, Pt]>) => wires.filter((w) => !skip.includes(w) && (dist(w[0], q) < 0.01 || dist(w[1], q) < 0.01));
    const chain: Array<[Pt, Pt]> = [];
    let q = tip;
    for (;;) {
      const nxt = touching(q, chain);
      if (!(q[0] === tip[0] && q[1] === tip[1]) && (nxt.length !== 1 || special.some((j) => dist(q, j) < 0.01))) break;
      if (nxt.length !== 1) return stop(`FAIL ${ref}.${pin}: ${nxt.length} wires at the pin tip in ${sym.name}: change the net by hand`);
      const w = nxt[0]!;
      chain.push(w);
      q = dist(w[0], q) < 0.01 ? w[1] : w[0];
    }
    if (touching(q, chain).length + special.filter((j) => dist(q, j) < 0.01).length < 2)
      return stop(`FAIL ${ref}.${pin}: removing its leg would cut the net in ${sym.name}: change the net by hand`);
    const k = (p: Pt) => `${round(p[0], 3)},${round(p[1], 3)}`;
    const keys = new Set(chain.map(([a, b]) => [k(a), k(b)].sort().join("|")));
    const drop: Span[] = [];
    for (const s of topLevelSpans(t, "wire")) {
      const pts = wirePts(t.slice(s.start, s.end));
      if (pts.length >= 2 && keys.has([k(pts[0]!), k(pts[pts.length - 1]!)].sort().join("|"))) drop.push(s);
    }
    t = removeSpans(t, drop);
    commit(appendRaw(t, globalLabel(newNet, tip[0], tip[1], 180, false)));
    return { sheet: sym.name, was: "(wired net; leg detached)" };
  }
  // a label names every wire it sits on, anywhere along it (KiCad), not only at an end
  const segs = wires.filter(([a, b]) => reach.some((q) => dist(a, q) < 0.01 || dist(b, q) < 0.01));
  let best: { d: number; span: Span; m: RegExpExecArray; kind: string } | null = null;
  for (const kind of ["global_label", "label"]) {
    for (const span of topLevelSpans(t, kind)) {
      const blk = t.slice(span.start, span.end);
      const m = /\((?:global_)?label "((?:[^"\\]|\\.)*)"/.exec(blk);
      const pt = atOf(blk);
      if (!m || !pt) continue;
      const d = Math.min(...reach.map((q) => dist(q, pt)), ...segs.map(([a, b]) => segDist(pt, a, b)));
      if (!best || d < best.d) best = { d, span, m, kind };
    }
  }
  if (!best || best.d > 0.05) {
    // an unused pin carries a no-connect flag at its tip: the flag goes, a label with the new net takes its place
    for (const ns of [...topLevelSpans(t, "no_connect")].sort((a, b) => b.start - a.start)) {
      const a = atOf(t.slice(ns.start, ns.end));
      if (a && Math.min(...reach.map((q) => dist(q, a))) < 0.01) {
        t = removeSpans(t, [ns]);
        commit(appendRaw(t, globalLabel(newNet, tip[0], tip[1], 0, true)));
        return { sheet: sym.name, was: "(no-connect flag replaced)" };
      }
    }
    return stop(`FAIL no label at the tip of ${ref}.${pin} (${tip}) in ${sym.name}: the schematic needs a manual edit`);
  }
  const old = best.m[1]!;
  // a local label carries the sheet-local name; the netlist prefixes the sheet path
  const text = best.kind === "label" && newNet.includes("/") ? newNet.slice(newNet.lastIndexOf("/") + 1) : newNet;
  const i = best.span.start + best.m.index + best.m[0].length - old.length - 1;
  commit(t.slice(0, i) + text + t.slice(i + old.length));
  return { sheet: sym.name, was: old };
}

/** A project-library symbol `LIB:NAME` from the project's sym-lib-table, renamed to its lib_id as a sheet's cache names it. */
export function projectLibSymbol(projectDir: string, libId: string): string {
  const [lib, name] = [libId.slice(0, libId.indexOf(":")), libId.slice(libId.indexOf(":") + 1)];
  const tablePath = join(projectDir, "sym-lib-table");
  if (!existsSync(tablePath)) return stop(`FAIL symbol library ${lib} not in ${projectDir}/sym-lib-table`);
  const table = readFileSync(tablePath, "utf8");
  const m = new RegExp(`\\(name "${lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)\\s*\\(type "[^"]*"\\)\\s*\\(uri "([^"]+)"\\)`).exec(table);
  if (!m) return stop(`FAIL symbol library ${lib} not in ${projectDir}/sym-lib-table`);
  const file = m[1]!.replace("${KIPRJMOD}", projectDir);
  const lt = readFileSync(file, "utf8");
  for (const s of topLevelSpans(lt, "symbol"))
    if (lt.startsWith(`(symbol "${name}"`, s.start)) return lt.slice(s.start, s.end).replace(`(symbol "${name}"`, `(symbol "${libId}"`);
  return stop(`FAIL symbol ${name} not in ${file}`);
}

/** Add a symbol copied from `like` (same sheet, instance path and field layout) with one global label per pin. */
export function addSymbol(
  sheets: SheetSet,
  like: string,
  ref: string,
  value: string,
  footprint: string,
  fields: Record<string, string>,
  pins: Record<string, string>,
  symbol?: string,
): string {
  const sym = sheets.symbol(like);
  if (!sym) return stop(`FAIL template symbol ${like} not found`);
  let t = sheets.texts.get(sym.name)!;
  let b = t.slice(sym.span.start, sym.span.end);
  if (symbol) {
    if (!t.slice(t.indexOf("(lib_symbols")).includes(`(symbol "${symbol}"`)) {
      const body = projectLibSymbol(sheets.dir, symbol);
      const i = t.indexOf("(lib_symbols") + "(lib_symbols".length;
      t = t.slice(0, i) + "\n    " + body + t.slice(i);
    }
    b = b.replace(/\(lib_id "[^"]+"\)/, () => `(lib_id "${symbol}")`);
    b = b.replace(/\n\s*\(pin "[^"]*"\s*\(uuid "[^"]+"\)\)/g, "");
    const entries = [...libPins(t, symbol).keys()].sort((x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0)).map((p) => `\n    (pin "${p}"\n      (uuid "${randomUUID()}"))`).join("");
    b = b.replace(/\n[ \t]*\(instances/, (m) => entries + m);
  }
  // place below everything on the sheet
  const ys = [...t.matchAll(/\(at [-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
  const X0 = 25.4;
  const Y0 = round((ys.length ? Math.max(...ys) : 0) + 25.4, 2);
  const at0 = /\(at ([-\d.]+) ([-\d.]+)((?: [-\d.]+)?)\)/.exec(b)!;
  const dx = X0 - Number(at0[1]), dy = Y0 - Number(at0[2]);
  let nb = b.replace(/\(at ([-\d.]+) ([-\d.]+)((?: [-\d.]+)?)\)/g, (_m, x: string, y: string, a: string) => `(at ${g(Number(x) + dx)} ${g(Number(y) + dy)}${a})`);
  nb = nb.replace(/\(uuid "[^"]+"\)/g, () => `(uuid "${randomUUID()}")`);
  for (const [k, v] of Object.entries({ Reference: ref, Value: value, Footprint: footprint, ...fields })) {
    const m = propRe(k).exec(nb);
    if (m) {
      const i = m.index + m[0].length - m[1]!.length - 1;
      nb = nb.slice(0, i) + esc(v) + nb.slice(i + m[1]!.length);
    }
  }
  nb = nb.replace(/\(reference "[^"]+"\)/g, `(reference "${ref}")`);
  const labels = Object.entries(pins).map(([pin, net]) => {
    const [x, y] = pinTip(t, nb, pin);
    return globalLabel(net, x, y, 180, false);
  });
  t = appendRaw(t, "\n  " + nb + labels.join(""));
  sheets.set(sym.name, t);
  return sym.name;
}

/**
 * Labels, wires and no-connect flags that hung on deleted symbols' pins (generated sheets put one label per pin,
 * sometimes on a short wire). Anything also touching a kept pin stays.
 */
export function removePinOrphans(before: string, after: string, gone: ReadonlySet<string>): { text: string; counts: { wire: number; label: number; no_connect: number } } {
  const refOf = (b: string) => /\(property\s+"Reference"\s+"([^"]+)"/.exec(b)?.[1] ?? null;
  const tips = (text: string, keep: boolean): Set<string> => {
    const out = new Set<string>();
    for (const s of topLevelSpans(text, "symbol")) {
      const b = text.slice(s.start, s.end);
      if (!b.slice(0, 200).includes("(lib_id") || (gone.has(refOf(b) ?? "") !== !keep)) continue;
      const lid = /\(lib_id "([^"]+)"\)/.exec(b)![1]!;
      try {
        for (const pin of libPins(text, lid).keys()) {
          const [x, y] = pinTip(text, b, pin);
          out.add(`${round(x, 2)},${round(y, 2)}`);
        }
      } catch (e) {
        if (!(e instanceof EditStop)) throw e;
      }
    }
    return out;
  };
  const R = (x: number, y: number) => `${round(x, 2)},${round(y, 2)}`;
  const dead = tips(before, false);
  const live = tips(after, true);
  const spans: Span[] = [];
  const counts = { wire: 0, label: 0, no_connect: 0 };
  for (const s of topLevelSpans(after, "wire")) {
    const pts = wirePts(after.slice(s.start, s.end)).map(([x, y]) => R(x, y));
    if (pts.some((q) => dead.has(q)) && !pts.some((q) => live.has(q))) {
      spans.push(s);
      counts.wire++;
      for (const q of pts) dead.add(q);
    }
  }
  for (const kind of ["global_label", "label", "no_connect"]) {
    for (const s of topLevelSpans(after, kind)) {
      const a = atOf(after.slice(s.start, s.end));
      if (a && dead.has(R(...a)) && !live.has(R(...a))) {
        spans.push(s);
        counts[kind === "no_connect" ? "no_connect" : "label"]++;
      }
    }
  }
  return { text: removeSpans(after, spans), counts };
}
