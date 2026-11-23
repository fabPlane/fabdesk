/** Board-side swap, add and change-net edits for the edit stage (the toolkit's `edit_ops`, board half). */
import { footprintCopperSignature } from "./footprint-copper";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { childLists, listSpanAt, type Span } from "../sexpr";
import { fpAttrFlags, stop } from "./sch";
import { footprintSpans, pose, sideOf, appendRaw } from "./text";
import { g, f4, mod } from "./fmt";

/** KiCad's own footprint libraries, searched after the project's table. Override with KICAD_FOOTPRINT_DIR (colon separated). */
export function kicadFootprintDirs(): string[] {
  const env = (process.env["KICAD_FOOTPRINT_DIR"] ?? "").split(":").filter(Boolean);
  return [...env, "/usr/share/kicad-nightly/footprints", "/usr/share/kicad/footprints", "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"];
}

const esc = (v: string) => v.replace(/"/g, '\\"');

export function boardToLib(b: string): string {
  return b
    .replace(/\n\s*\(at [-\d. ]+\)/, "")
    .replace(/\s*\(uuid "[^"]*"\)/g, "")
    .replace(/\s*\(net (?:\d+ )?"[^"]*"\)/g, "")
    .replace(/\s*\(path "[^"]*"\)/g, "");
}

/** Library text of `libId` (`LIB:NAME`): the project's fp-lib-table, KiCad's libraries, the same name elsewhere, or an unrotated front copy on the board. */
export function libFootprint(projectDir: string, libId: string, boardText?: string): { text: string; src: string } {
  const lib = libId.slice(0, libId.indexOf(":"));
  const name = libId.slice(libId.indexOf(":") + 1);
  const tablePath = join(projectDir, "fp-lib-table");
  if (existsSync(tablePath)) {
    const re = new RegExp(`\\(lib\\s+\\(name "?${lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\)\\s*\\(type "?[^)"]*"?\\)\\s*\\(uri "?([^)"]+)"?\\)`);
    const m = re.exec(readFileSync(tablePath, "utf8"));
    if (m) {
      const p = join(m[1]!.replace("${KIPRJMOD}", projectDir), `${name}.kicad_mod`);
      if (existsSync(p)) return { text: readFileSync(p, "utf8"), src: p };
    }
  }
  for (const d of kicadFootprintDirs()) {
    const p = join(d, `${lib}.pretty`, `${name}.kicad_mod`);
    if (existsSync(p)) return { text: readFileSync(p, "utf8"), src: p };
  }
  for (const d of kicadFootprintDirs()) {
    if (!existsSync(d)) continue;
    const hits = readdirSync(d).filter((n) => n.endsWith(".pretty")).sort().map((n) => join(d, n, `${name}.kicad_mod`)).filter((p) => existsSync(p));
    if (hits.length) return { text: readFileSync(hits[0]!, "utf8"), src: `${hits[0]} (same name; ${lib} not installed)` };
  }
  if (boardText) {
    for (const [ref, s] of footprintSpans(boardText)) {
      const b = boardText.slice(s.start, s.end);
      if (!b.startsWith(`(footprint "${libId}"`)) continue;
      const at = /\n\s*\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(b);
      if (b.slice(0, 300).includes('(layer "F.Cu")') && at && Number(at[3] ?? 0) === 0) return { text: boardToLib(b), src: `board copy of ${ref} (${lib} not installed)` };
    }
  }
  return stop(`FAIL footprint ${libId}: not in ${tablePath}, the KiCad libraries (also by name) or as an unrotated front copy on the board`);
}

/** Child lists of the (footprint ...) node in a .kicad_mod text. */
function libChildren(text: string): string[] {
  const i = text.indexOf("(footprint");
  const span = listSpanAt(text, i);
  return childLists(text, span).map((s) => text.slice(s.start, s.end));
}

const neg = (v: string) => {
  const f = -Number(v);
  return f !== 0 ? g(f) : "0";
};

/** KiCad flip to B: mirror y, negate angles, swap F/B layers. */
function flip(child: string): string {
  return child
    .replace(/\((at|start|end|center|mid|xy) ([-\d.]+) ([-\d.]+)((?: [-\d.]+)?)\)/g, (_m, k: string, x: string, y: string, a: string) => `(${k} ${x} ${neg(y)}${a ? " " + neg(a.trim()) : ""})`)
    .replace(/"([FB])\.(Cu|Mask|Paste|SilkS|Fab|CrtYd|Adhes|Silkscreen|Courtyard|Adhesive)"/g, (_m, s: string, l: string) => `"${s === "F" ? "B" : "F"}.${l}"`);
}

function turn(child: string, rot: number): string {
  if (!rot) return child;
  return child.replace(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/g, (_m, x: string, y: string, a?: string) => `(at ${x} ${y} ${g(mod(Number(a ?? 0) + rot, 360))})`);
}

/** Board footprint block from a library footprint (KiCad 10.99 board format: transform + absolute child angles). */
export function boardFootprint(
  libText: string,
  libId: string,
  x: number,
  y: number,
  rot: number,
  side: string,
  props: Record<string, string>,
  padNets: Record<string, string>,
  keepNodes: string[],
  fpUuid: string,
): string {
  const kids = libChildren(libText).filter((c) => !/^\((version|generator|generator_version|layer|uuid)\b/.test(c));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let c of kids) {
    const m = /^\(property "([^"]+)" "((?:[^"\\]|\\.)*)"/.exec(c);
    if (m) {
      seen.add(m[1]!);
      if (m[1]! in props) {
        const i = m[0].length - m[2]!.length - 1;
        c = c.slice(0, i) + esc(props[m[1]!]!) + c.slice(i + m[2]!.length);
      }
    }
    const pm = /^\(pad "([^"]*)"/.exec(c);
    if (pm) {
      const padUuid = randomUUID();
      c = c.replace(/\(uuid "[^"]+"\)/g, `(uuid "${padUuid}")`);
      const net = padNets[pm[1]!];
      c = c.replace(/\s*\(net [^()]*\)/g, "");
      if (net) c = c.slice(0, -1).trimEnd() + ` (net "${net}"))`;
    }
    if (side === "B") c = flip(c);
    out.push(turn(c, rot));
  }
  for (const [k, v] of Object.entries(props))
    if (!seen.has(k))
      out.push(`(property "${k}" "${v}" (at 0 0 0) (layer "${side}.Fab") (hide yes) (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))`);
  const head = `(footprint "${libId}"\n    (transform\n      (translate ${f4(x)} ${f4(y)})\n      (rotate ${g(mod(rot, 360))})\n      (scale 1 1))\n    (layer "${side}.Cu")\n    (uuid "${fpUuid}")`;
  return head + [...keepNodes, ...out].map((c) => "\n    " + c).join("") + ")";
}

export interface FpInfo {
  span: Span;
  props: Record<string, string>;
  nets: Record<string, string>;
  keep: string[];
  uuid: string;
  pose: [number, number, number];
  side: "F" | "B";
  lib: string;
}

export function fpInfo(text: string, ref: string): FpInfo {
  const span = footprintSpans(text).get(ref);
  if (!span) return stop(`FAIL ${ref}: not on the board`);
  const b = text.slice(span.start, span.end);
  const props: Record<string, string> = {};
  for (const m of b.matchAll(/\(property "([^"]+)" "((?:[^"\\]|\\.)*)"/g)) props[m[1]!] = m[2]!;
  const nets: Record<string, string> = {};
  for (const pm of b.matchAll(/\(pad "([^"]*)"/g)) {
    const ps = pm.index!;
    const end = listSpanAt(b, ps).end;
    const n = /\(net (?:\d+ )?"([^"]*)"\)/.exec(b.slice(ps, end));
    if (n) nets[pm[1]!] = n[1]!;
  }
  const keep = [...b.matchAll(/\((?:path|sheetname|sheetfile) "[^"]*"\)/g)].map((m) => m[0]);
  const attr = /\(attr [^()]*\)/.exec(b);
  return {
    span,
    props,
    nets,
    keep: [...keep, ...(attr ? [attr[0]] : [])],
    uuid: /\(uuid "([^"]+)"\)/.exec(b)![1]!,
    pose: pose(b),
    side: sideOf(b),
    lib: /^\(footprint "([^"]+)"/.exec(b)![1]!,
  };
}

export interface SwapLog {
  ref: string;
  from: string;
  to: string;
  library_file: string;
  pads_without_place: string[];
  sym_flags: { in_bom: string; dnp: string };
  copper_preserved: boolean;
}

/** Rebuild footprint `ref` from `libId`, keeping pose, pad-number -> net map and sheet path. `side` flips it. */
export function swapFootprint(text: string, projectDir: string, ref: string, libId: string, side?: string): { text: string; log: SwapLog } {
  const info = fpInfo(text, ref);
  if (side) info.side = side[0] as "F" | "B";
  const lib = libFootprint(projectDir, libId);
  const props = { ...info.props, Footprint: libId };
  const [x, y, rot] = info.pose;
  let keep = info.keep;
  if (/\(attr /.test(lib.text)) keep = keep.filter((c) => !c.startsWith("(attr "));
  const fresh = boardFootprint(lib.text, libId, x, y, rot, info.side, props, info.nets, keep, info.uuid);
  const padNames = new Set([...fresh.matchAll(/\(pad "([^"]*)"/g)].map((m) => m[1]!));
  const missing = Object.keys(info.nets).filter((p) => !padNames.has(p)).sort();
  const next = text.slice(0, info.span.start) + fresh + text.slice(info.span.end);
  const preserved = footprintCopperSignature(text, ref) === footprintCopperSignature(next, ref);
  return {
    text: next,
    log: { ref, from: info.lib, to: libId, library_file: lib.src, pads_without_place: missing, sym_flags: fpAttrFlags(fresh), copper_preserved: preserved },
  };
}

/** Add or remove dnp (with exclude_from_bom) in REF's (attr ...) node. */
export function setFpDnp(text: string, ref: string, dnp: boolean): string {
  const info = fpInfo(text, ref);
  const b = text.slice(info.span.start, info.span.end);
  const m = /\(attr ([^)]*)\)/.exec(b);
  const words = (m ? m[1]!.trim().split(/\s+/).filter(Boolean) : []).filter((w) => w !== "dnp" && w !== "exclude_from_bom").concat(dnp ? ["exclude_from_bom", "dnp"] : []);
  const node = `(attr ${words.join(" ")})`;
  const nb = m ? b.slice(0, m.index) + node + b.slice(m.index! + m[0].length) : b.replace("\n", () => `\n\t\t${node}\n`);
  return text.slice(0, info.span.start) + nb + text.slice(info.span.end);
}

export function setValue(text: string, ref: string, value?: string | null, fields?: Record<string, string>): string {
  const span = footprintSpans(text).get(ref);
  if (!span) return stop(`FAIL ${ref}: not on the board`);
  let b = text.slice(span.start, span.end);
  const kv: Array<[string, string]> = [...(value != null ? ([["Value", value]] as Array<[string, string]>) : []), ...Object.entries(fields ?? {})];
  for (const [k, v] of kv) {
    const m = new RegExp(`\\(property "${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" "((?:[^"\\\\]|\\\\.)*)"`).exec(b);
    if (m) {
      const i = m.index + m[0].length - m[1]!.length - 1;
      b = b.slice(0, i) + v + b.slice(i + m[1]!.length);
    } else {
      b = b.slice(0, -1).trimEnd() + `\n    (property "${k}" "${v}" (at 0 0 0) (layer "${sideOf(b)}.Fab") (hide yes) (uuid "${randomUUID()}") (effects (font (size 1 1) (thickness 0.15))))` + ")";
    }
  }
  return text.slice(0, span.start) + b + text.slice(span.end);
}

export function addFootprint(
  text: string,
  projectDir: string,
  ref: string,
  libId: string,
  value: string,
  fields: Record<string, string>,
  pins: Record<string, string>,
  at: [number, number, number],
  side: string,
  schKeep: string[],
): { text: string; src: string } {
  const lib = libFootprint(projectDir, libId, text);
  const props = { Reference: ref, Value: value, Footprint: libId, ...fields };
  const fresh = boardFootprint(lib.text, libId, at[0], at[1], at[2], side, props, pins, schKeep, randomUUID());
  return { text: appendRaw(text, "\n  " + fresh), src: lib.src };
}

export function setPadNet(text: string, ref: string, pad: string, net: string): { text: string; was: string } {
  const span = footprintSpans(text).get(ref);
  if (!span) return stop(`FAIL ${ref}: not on the board`);
  const b = text.slice(span.start, span.end);
  const pm = new RegExp(`\\(pad "${pad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(b);
  if (!pm) return stop(`FAIL ${ref} has no pad ${pad}`);
  const padSpan = listSpanAt(b, pm.index);
  const padTxt = b.slice(padSpan.start, padSpan.end);
  const old = /\(net (?:\d+ )?"([^"]*)"\)/.exec(padTxt);
  const nw = old ? padTxt.replace(/\(net (?:\d+ )?"[^"]*"\)/, () => `(net "${net}")`) : padTxt.slice(0, -1) + ` (net "${net}"))`;
  const nb = b.slice(0, padSpan.start) + nw + b.slice(padSpan.end);
  return { text: text.slice(0, span.start) + nb + text.slice(span.end), was: old ? old[1]! : "" };
}

/** Older boards list nets at the top ((net N "name")); 10.99 boards name nets inline. Add a declaration when the file has the list. */
export function ensureNetDeclared(text: string, net: string): string {
  const head = text.slice(0, 200000);
  const decl = [...head.matchAll(/^\s*\(net (\d+) "([^"]*)"\)/gm)];
  if (decl.length && !decl.some((d) => d[2] === net)) {
    const k = Math.max(...decl.map((d) => Number(d[1]))) + 1;
    const last = decl[decl.length - 1]!;
    const end = last.index! + last[0].length;
    return text.slice(0, end) + `\n  (net ${k} "${net}")` + text.slice(end);
  }
  return text;
}
