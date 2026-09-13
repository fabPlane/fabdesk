/**
 * Move footprints in a `.kicad_pcb` by editing the file text. The API's `UpdateItems` on a footprint
 * moves only its anchor (fab_pcb gap G28), while in the file format the children are relative to the
 * footprint's own transform, so rewriting that one node moves pads, silkscreen and text together.
 *
 * Handles the v10 form `(transform (translate x y) (rotate r) (scale 1 1))` and the legacy
 * `(at x y [r])` (translation only there: legacy child angles are absolute).
 */

export type Placement = {
  /** Reference designator, e.g. `J2`. */
  ref: string;
  /** Footprint origin in mm, KiCad board coordinates (y grows downwards). */
  x: number;
  y: number;
  /** Degrees, counter-clockwise as KiCad shows it; omit to keep the current rotation. */
  rotation?: number;
};

export type PlaceResult = {
  text: string;
  moved: Array<{ ref: string; x: number; y: number; rotation: number }>;
  missing: string[];
};

const num = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** Index just past the `)` that closes the list opening at `open` (which must point at a `(`). */
function closeOf(text: string, open: number): number {
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
  throw new Error("unbalanced parentheses in board file");
}

/** Top-level footprint blocks: `[start, end)` plus the reference designator. */
function footprints(text: string): Array<{ start: number; end: number; ref: string | null }> {
  const out: Array<{ start: number; end: number; ref: string | null }> = [];
  const re = /\(footprint\s+"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = closeOf(text, start);
    const body = text.slice(start, end);
    const raw =
      /\(property\s+"Reference"\s+"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ??
      /\(fp_text\s+reference\s+"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ??
      null;
    out.push({ start, end, ref: raw === null ? null : raw.replace(/\\(.)/g, "$1") });
    re.lastIndex = end;
  }
  return out;
}

/** The footprint's own placement node inside its block: the first depth-1 `(transform` or `(at`. */
function ownPlacement(
  body: string,
): { kind: "transform" | "at"; start: number; end: number } | null {
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
        if (body.startsWith("(transform", i))
          return { kind: "transform", start: i, end: closeOf(body, i) };
        if (/^\(at[\s)]/.test(body.slice(i, i + 4)))
          return { kind: "at", start: i, end: closeOf(body, i) };
      }
    } else if (ch === ")") depth--;
  }
  return null;
}

export function placeFootprints(text: string, placements: Placement[]): PlaceResult {
  const wanted = new Map(placements.map((p) => [p.ref, p]));
  const moved: PlaceResult["moved"] = [];
  const blocks = footprints(text);
  // Rewrite from the end so earlier offsets stay valid.
  let out = text;
  for (const block of [...blocks].reverse()) {
    const p = block.ref ? wanted.get(block.ref) : undefined;
    if (!p) continue;
    const body = out.slice(block.start, block.end);
    const node = ownPlacement(body);
    if (!node) throw new Error(`footprint ${p.ref} has no placement node`);
    const current = body.slice(node.start, node.end);
    let rotation: number;
    let replacement: string;
    if (node.kind === "transform") {
      const rot = /\(rotate\s+(-?[\d.]+)\)/.exec(current);
      rotation = p.rotation ?? (rot ? Number(rot[1]) : 0);
      replacement = current
        .replace(/\(translate\s+-?[\d.]+\s+-?[\d.]+\)/, `(translate ${num(p.x)} ${num(p.y)})`)
        .replace(/\(rotate\s+-?[\d.]+\)/, `(rotate ${num(rotation)})`);
      if (!/\(translate/.test(current))
        throw new Error(`footprint ${p.ref}: transform without translate`);
    } else {
      const at = /^\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\s*\)$/.exec(current.trim());
      if (!at) throw new Error(`footprint ${p.ref}: unreadable (at …)`);
      rotation = at[3] ? Number(at[3]) : 0;
      if (p.rotation !== undefined && p.rotation !== rotation)
        throw new Error(
          `footprint ${p.ref}: this board file stores child angles absolutely; rotation needs the transform format`,
        );
      replacement = `(at ${num(p.x)} ${num(p.y)}${at[3] ? ` ${at[3]}` : ""})`;
    }
    out = out.slice(0, block.start + node.start) + replacement + out.slice(block.start + node.end);
    moved.push({ ref: p.ref, x: p.x, y: p.y, rotation });
    wanted.delete(p.ref);
  }
  return { text: out, moved: moved.reverse(), missing: [...wanted.keys()] };
}
