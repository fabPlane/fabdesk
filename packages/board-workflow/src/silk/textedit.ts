/** Text-level edits of a `.kicad_pcb`: only Reference properties and free silk texts change; everything else is byte-identical. */

export function blockEnd(t: string, i: number): number {
  let depth = 0;
  let j = i;
  for (;;) {
    const ch = t[j];
    if (ch === undefined) throw new Error("unbalanced block");
    if (ch === '"') {
      j++;
      while (t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
}

/** Top-level child spans (start, end) of an s-expression block. */
export function children(blk: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < blk.length; j++) {
    const ch = blk[j]!;
    if (ch === '"') {
      j++;
      while (blk[j] !== '"') j += blk[j] === "\\" ? 2 : 1;
    } else if (ch === "(") {
      depth++;
      if (depth === 2) start = j;
    } else if (ch === ")") {
      if (depth === 2) out.push([start, j + 1]);
      depth--;
    }
  }
  return out;
}

export function refPropertySpan(t: string, ref: string): [number, number] {
  const key = `(property "Reference" "${ref}"`;
  const i = t.indexOf(key);
  if (i < 0) throw new Error(`${ref}: no Reference property in the board`);
  if (t.indexOf(key, i + 1) >= 0) throw new Error(`${ref}: two Reference properties`);
  return [i, blockEnd(t, i)];
}

/** KiCad's own precision: up to 6 decimals (1 nm), trailing zeros dropped. */
const g6 = (v: number) => Number(v.toFixed(6)).toString();

export function rewriteProperty(blk: string, at: [number, number, number], layer: string, hidden: boolean, height: number, stroke: number, mirror: boolean): string {
  const kids = children(blk);
  const head = kids.length ? blk.slice(0, kids[0]![0]) : blk.slice(0, -1);
  const ind = /\n([ \t]*)\(/.exec(blk)?.[1] ?? "      ";
  const keep: string[] = [];
  for (const [a, b] of kids) {
    const k = blk.slice(a, b);
    if (["at", "layer", "hide", "effects"].includes(/^\((\w+)/.exec(k)![1]!)) continue;
    keep.push(k);
  }
  const eff = `(effects\n${ind}  (font\n${ind}    (size ${g6(height)} ${g6(height)})\n${ind}    (thickness ${g6(stroke)}))` + (mirror ? `\n${ind}  (justify mirror))` : ")");
  const parts = [`(at ${g6(at[0])} ${g6(at[1])} ${g6(at[2])})`, `(layer "${layer}")`, ...(hidden ? ["(hide yes)"] : []), ...keep, eff];
  return head.trimEnd() + "\n" + parts.slice(0, -1).map((q) => `${ind}${q}\n`).join("") + `${ind}${parts[parts.length - 1]})`;
}

export function textSpan(t: string, uuid: string): [number, number] {
  const i = t.indexOf(`(uuid "${uuid}")`);
  const a = t.lastIndexOf("(gr_text ", i);
  if (i < 0 || a < 0) throw new Error(`board text ${uuid} not found`);
  const b = blockEnd(t, a);
  if (!(a < i && i < b)) throw new Error(`board text ${uuid}: uuid outside its gr_text`);
  return [a, b];
}

/** New anchor (centre), angle and size; justification centred (mirror kept). Nothing else changes. */
export function rewriteText(blk: string, at: [number, number, number], height: number, stroke: number): string {
  let b = blk.replace(/\(at [-\d.]+ [-\d.]+(?: [-\d.]+)?\)/, `(at ${g6(at[0])} ${g6(at[1])} ${g6(at[2])})`);
  b = b.replace(/\(size [-\d.]+ [-\d.]+\)/, `(size ${g6(height)} ${g6(height)})`);
  b = b.replace(/\(thickness [-\d.]+\)/, `(thickness ${g6(stroke)})`);
  b = b.replace(/\(justify ([^()]*)\)/g, (_m, inner: string) => {
    const keep = inner.split(/\s+/).filter((w) => w === "mirror");
    return keep.length ? `(justify ${keep.join(" ")})` : "";
  });
  return b.replace(/\n[ \t]*\n/g, "\n");
}

/** `(hide yes)` on a Reference property (after its layer), when it is not hidden already. */
export function hidePropertyBlock(blk: string): string {
  if (blk.includes("(hide yes)")) return blk;
  const kids = children(blk);
  const la = kids.find(([a]) => blk.startsWith("(layer", a));
  const ind = /\n([ \t]*)\(/.exec(blk)?.[1] ?? "      ";
  if (la) return blk.slice(0, la[1]) + `\n${ind}(hide yes)` + blk.slice(la[1]);
  return blk.slice(0, -1) + `\n${ind}(hide yes))`;
}

/** The board text with every Reference property hidden and every free silk text removed (what a clean silk plot needs). */
export function plotCopy(t: string): string {
  const edits: Array<[number, number, string]> = [];
  for (const m of t.matchAll(/\(property "Reference" /g)) {
    const a = m.index!;
    const b = blockEnd(t, a);
    edits.push([a, b, hidePropertyBlock(t.slice(a, b))]);
  }
  for (const m of t.matchAll(/\(gr_text /g)) {
    const a = m.index!;
    const b = blockEnd(t, a);
    if (/\(layer "[FB]\.Silk(S|screen)"\)/.test(t.slice(a, b))) edits.push([a, b, ""]);
  }
  let out = t;
  for (const [a, b, nb] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + nb + out.slice(b);
  return out;
}

/** Board text without Reference properties (and the moved free texts): equal before/after means only silk labels changed. */
export function masked(t: string, textUuids: readonly string[] = []): string {
  const spans: Array<[number, number]> = [...t.matchAll(/\(property "Reference" /g)].map((m) => [m.index!, blockEnd(t, m.index!)] as [number, number]);
  for (const u of textUuids) spans.push(textSpan(t, u));
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let i = 0;
  for (const [a, b] of spans) {
    if (a < i) continue;
    out += t.slice(i, a);
    i = b;
  }
  return out + t.slice(i);
}
