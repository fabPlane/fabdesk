/** Text-level access to a `.kicad_pcb` for edits: footprint spans, poses, and span removal (the toolkit's `block_pass`). */
import { removeSpans, topLevelSpans, type Span } from "../sexpr";

export function footprintSpans(text: string): Map<string, Span> {
  const out = new Map<string, Span>();
  for (const s of topLevelSpans(text, "footprint")) {
    const m = /\(property "Reference" "([^"]+)"/.exec(text.slice(s.start, s.end));
    if (m) out.set(m[1]!, s);
  }
  return out;
}

export const refOf = (block: string): string | null => /\(property\s+"Reference"\s+"([^"]+)"/.exec(block)?.[1] ?? null;

export { pose, setPose } from "../layout/text";

export const sideOf = (body: string): "F" | "B" => (/\(layer "([FB])\.Cu"\)/.exec(body)?.[1] ?? "F") as "F" | "B";

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
