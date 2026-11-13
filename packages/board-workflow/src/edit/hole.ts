/**
 * Resize a named unnetted NPTH locating hole (the toolkit's `flow/mechanical_hole.py`, line for line): the hole (round
 * when X = Y, else oval), its Value, its courtyard rectangles and its named surface keep-out, on the board and in the
 * project's library footprint. Nothing else moves; no copper is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readBoard } from "../board";
import { kid, kids, parseSexpr, topLevelSpans } from "../sexpr";
import { g } from "./fmt";
import { EditStop } from "./sch";
import { footprintSpans } from "./text";

export interface HoleSpec {
  /** The locating hole's footprint reference (one unnetted NPTH pad at its origin, footprint at rotation 0). */
  ref: string;
  /** [X, Y] mm: round when equal, else an oval slot. */
  size_mm: [number, number];
  /** Courtyard and keep-out margin round the hole, mm (default 0.25). */
  clearance_mm?: number;
  /** false: the board has no `Mechanical REF surface copper and via clearance` keep-out to resize (the toolkit requires one). */
  keepout?: boolean;
}

export interface HoleRecord {
  source_sha256: string;
  candidate_sha256: string;
  ref: string;
  centre_mm: [number, number];
  size_mm: [number, number];
  clearance_mm: number;
  copper_authored: 0;
  library_file: string;
}

const fail = (m: string): never => {
  throw new EditStop(`FAIL hole: ${m}`);
};

/** End of the list opening at `start`, counting parentheses only (as the script does). */
function balancedEnd(body: string, start: number): number {
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    depth += (body[i] === "(" ? 1 : 0) - (body[i] === ")" ? 1 : 0);
    if (depth === 0) return i + 1;
  }
  return fail("unbalanced footprint text");
}

/** The Value the script gives the resized hole. */
export const holeValue = (ref: string, [x, y]: [number, number]) => `Locator_${ref.startsWith("FIT_") ? ref.slice(4) : ref}_${g(x)}x${g(y)}mm_NPTH`;

/** `mechanical_hole.change_fp`: the footprint text (board copy or library file) with the new hole. */
export function changeFp(body: string, ref: string, size: [number, number], gap: number): string {
  const root = parseSexpr(body);
  const pads = kids(root, "pad");
  if (pads.length !== 1 || pads[0]![2] !== "np_thru_hole" || kid(pads[0]!, "net")) fail(`${ref}: expected one unnetted NPTH pad`);
  const at = kid(pads[0]!, "at");
  if (at?.[1] !== "0" || at?.[2] !== "0") fail(`${ref}: offset hole unsupported`);
  const [x, y] = size;
  const shape = x === y ? "circle" : "oval";
  const ps = body.indexOf("(pad ");
  const pe = balancedEnd(body, ps);
  let pad = body.slice(ps, pe);
  pad = pad.replace(/^(\(pad\s+"[^"]*"\s+np_thru_hole\s+)\w+/, (_m, h: string) => h + shape);
  pad = pad.replace(/\(size [^()]+\)/g, () => `(size ${g(x)} ${g(y)})`);
  pad = pad.replace(/\(drill [^()]+\)/g, () => (shape === "circle" ? `(drill ${g(x)})` : `(drill oval ${g(x)} ${g(y)})`));
  body = body.slice(0, ps) + pad + body.slice(pe);
  const value = holeValue(ref, size);
  body = body.replace(/(\(property\s+"Value"\s+")[^"]*/g, (_m, h: string) => h + value);
  // these NPTH footprints carry only rectangular courtyard graphics
  const rects = [...body.matchAll(/\(fp_rect\b/g)].map((m) => m.index!);
  for (const start of rects.reverse()) {
    const end = balancedEnd(body, start);
    let gr = body.slice(start, end);
    if (!/\(layer "[FB]\.CrtYd"\)/.test(gr)) continue;
    gr = gr.replace(/\(start [^()]+\)/g, () => `(start ${g(-x / 2 - gap)} ${g(-y / 2 - gap)})`);
    gr = gr.replace(/\(end [^()]+\)/g, () => `(end ${g(x / 2 + gap)} ${g(y / 2 + gap)})`);
    body = body.slice(0, start) + gr + body.slice(end);
  }
  return body;
}

/** The project's library file for footprint `libId` (`LIB:NAME` through the project's fp-lib-table, `${KIPRJMOD}` only). */
export function projectLibFile(projectDir: string, libId: string): string | null {
  const i = libId.indexOf(":");
  if (i < 0) return null;
  const lib = libId.slice(0, i);
  const name = libId.slice(i + 1);
  const table = join(projectDir, "fp-lib-table");
  if (!existsSync(table)) return null;
  const re = new RegExp(`\\(lib\\s+\\(name "?${lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\)\\s*\\(type "?[^)"]*"?\\)\\s*\\(uri "?([^)"]+)"?\\)`);
  const m = re.exec(readFileSync(table, "utf8"));
  if (!m || !m[1]!.startsWith("${KIPRJMOD}")) return null;
  const p = resolve(join(m[1]!.replace("${KIPRJMOD}", projectDir), `${name}.kicad_mod`));
  return relative(projectDir, p).startsWith("..") ? null : p;
}

/**
 * `mechanical_hole.main` on board text: the new board, the new library footprint text, and the keep-out it resized.
 * `libText` is the project's library footprint (`projectLibFile`). Throws EditStop("FAIL hole: ...") where the script asserts.
 */
export function holeEdit(text: string, spec: HoleSpec, libText: string): { text: string; lib: string; centre: [number, number] } {
  const { ref } = spec;
  const size = spec.size_mm;
  const gap = spec.clearance_mm ?? 0.25;
  if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => typeof v === "number" && v > 0 && v < 10)) fail("size_mm is [X, Y] with 0 < X, Y < 10 mm");
  const span = footprintSpans(text).get(ref);
  if (!span) return fail(`${ref}: not on the board`);
  const nw = changeFp(text.slice(span.start, span.end), ref, size, gap);
  const f = readBoard(parseSexpr(text)).footprints.get(ref);
  if (!f) return fail(`${ref}: not on the board`);
  if (f.rot !== 0) fail(`${ref}: rotated locating holes not supported`);
  let t = text.slice(0, span.start) + nw + text.slice(span.end);
  if (spec.keepout !== false) {
    const zones: Array<[number, number, string]> = [];
    for (const zs of topLevelSpans(t, "zone")) {
      let z = t.slice(zs.start, zs.end);
      if (!z.includes(`Mechanical ${ref} surface copper and via clearance`)) continue;
      if (!z.includes("(keepout") || z.includes("(filled_polygon")) fail(`${ref}: the named surface keep-out must be an unfilled keep-out`);
      const hx = size[0] / 2 + gap, hy = size[1] / 2 + gap;
      const pts = ([[f.x - hx, f.y - hy], [f.x + hx, f.y - hy], [f.x + hx, f.y + hy], [f.x - hx, f.y + hy]] as Array<[number, number]>).map(([px, py]) => `(xy ${g(px)} ${g(py)})`).join(" ");
      let n = 0;
      z = z.replace(/\(polygon\s+\(pts(?:\s*\(xy [^()]+\))*\s*\)\s*\)/g, () => (n++, `(polygon (pts ${pts}))`));
      if (n !== 1) fail(`${ref}: expected one keep-out polygon`);
      zones.push([zs.start, zs.end, z]);
    }
    if (zones.length !== 1) fail(`${ref}: expected one zone named "Mechanical ${ref} surface copper and via clearance" (give keepout: false when the board has none), found ${zones.length}`);
    for (const [b, e, z] of zones.reverse()) t = t.slice(0, b) + z + t.slice(e);
  }
  return { text: t, lib: changeFp(libText, ref, size, gap), centre: [f.x, f.y] };
}
