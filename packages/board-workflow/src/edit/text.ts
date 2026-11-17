/** Text-level access to a `.kicad_pcb` for edits: footprint spans, poses, and span removal (the toolkit's `block_pass`). */
import { removeSpans, topLevelSpans, type Span } from "../sexpr";
import { f4, g, mod } from "./fmt";

export function footprintSpans(text: string): Map<string, Span> {
  const out = new Map<string, Span>();
  for (const s of topLevelSpans(text, "footprint")) {
    const m = /\(property "Reference" "([^"]+)"/.exec(text.slice(s.start, s.end));
    if (m) out.set(m[1]!, s);
  }
  return out;
}

export const refOf = (block: string): string | null => /\(property\s+"Reference"\s+"([^"]+)"/.exec(block)?.[1] ?? null;

export function pose(body: string): [number, number, number] {
  const t = /\(transform\s+\(translate ([-\d.]+) ([-\d.]+)\)\s+\(rotate ([-\d.]+)\)/.exec(body);
  if (t) return [Number(t[1]), Number(t[2]), Number(t[3])];
  const i = body.indexOf("(property");
  const head = i < 0 ? body : body.slice(0, i);
  const at = /\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(head);
  if (!at) throw new Error("footprint has no pose");
  return [Number(at[1]), Number(at[2]), Number(at[3] ?? 0)];
}

export const sideOf = (body: string): "F" | "B" => (/\(layer "([FB])\.Cu"\)/.exec(body)?.[1] ?? "F") as "F" | "B";

/** Footprint body moved to (x1, y1) at rotation r1; every child angle turns by the rotation delta (KiCad stores them absolutely). */
export function setPose(body: string, x1: number, y1: number, r1: number): string {
  const [, , r0] = pose(body);
  const d = mod(r1 - r0, 360);
  let out = body.replace(/\(translate [-\d.]+ [-\d.]+\)/, `(translate ${f4(x1)} ${f4(y1)})`);
  if (d) {
    out = out.replace(/\(rotate [-\d.]+\)/, `(rotate ${g(mod(r1, 360))})`);
    out = out.replace(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/g, (_m, x: string, y: string, a?: string) => `(at ${x} ${y} ${g(mod(Number(a ?? 0) + d, 360))})`);
  }
  return out;
}

/** Delete every top-level `kind` block for which `pred(blockText)` holds. */
export function removeBlocks(text: string, kind: string, pred: (block: string) => boolean): { text: string; removed: number } {
  const spans = topLevelSpans(text, kind).filter((s) => pred(text.slice(s.start, s.end)));
  return { text: removeSpans(text, spans), removed: spans.length };
}

/** Append `raw` (each node starting with its own line break) as the last children of the file's root list. */
export function appendRaw(text: string, raw: string): string {
  const end = text.trimEnd().lastIndexOf(")");
  return text.slice(0, end).trimEnd() + raw + "\n)\n";
}
