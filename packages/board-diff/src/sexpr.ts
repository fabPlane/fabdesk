/** Small KiCad s-expression helpers. Enough to walk footprints, nets, tracks, and symbols. */

export function closeOf(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("unbalanced parentheses in KiCad file");
}

export function unquote(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

export function quoted(text: string): string | undefined {
  const match = /"((?:[^"\\]|\\.)*)"/.exec(text);
  return match?.[1] === undefined ? undefined : unquote(match[1]);
}

export type SexprBlock = { name: string; start: number; end: number; body: string };

/** Direct children of the root `(kicad_pcb …)` / `(kicad_sch …)` list. */
export function rootChildren(text: string): SexprBlock[] {
  const start = text.indexOf("(");
  if (start < 0) return [];
  try {
    return childBlocks(text.slice(start, closeOf(text, start)));
  } catch {
    return [];
  }
}

export function topLevelBlocks(text: string, name: string): SexprBlock[] {
  return rootChildren(text).filter((block) => block.name === name);
}

export function childBlocks(body: string): SexprBlock[] {
  const out: SexprBlock[] = [];
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") {
      depth++;
      if (depth === 2) {
        const name = /^\(([^\s()]*)/.exec(body.slice(i, i + 64))?.[1] ?? "";
        const end = closeOf(body, i);
        out.push({ name, start: i, end, body: body.slice(i, end) });
        i = end - 1;
        depth--;
      }
    } else if (ch === ")") depth--;
  }
  return out;
}

export function childNamed(body: string, name: string): SexprBlock | undefined {
  return childBlocks(body).find((block) => block.name === name);
}

export function propertyValue(body: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const modern = new RegExp(`\\(property\\s+"${escaped}"\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(body);
  if (modern?.[1] !== undefined) return unquote(modern[1]);
  return undefined;
}

export function parseAt(text: string): { x: number; y: number; rotation: number } | undefined {
  const match = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  return { x: Number(match[1]), y: Number(match[2]), rotation: match[3] ? Number(match[3]) : 0 };
}

export function parseXy(text: string): { x: number; y: number } | undefined {
  const match = /\((?:xy|start|end|mid|at|center)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
}

export function roundMm(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
