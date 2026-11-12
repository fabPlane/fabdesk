/** Minimal KiCad s-expression reader: lists are arrays, atoms and quoted strings are strings. */
export type SNode = SItem[];
export type SItem = string | SNode;

const WS = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

function unescapeQuoted(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\" || i === raw.length - 1) {
      out += c;
      continue;
    }
    const n = raw[++i]!;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += n;
  }
  return out;
}

/** Parse the first top-level list of `text`. Throws on an unbalanced file. */
export function parseSexpr(text: string): SNode {
  const stack: SNode[] = [];
  let root: SNode | null = null;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (WS.has(c)) {
      i++;
    } else if (c === "(") {
      const node: SNode = [];
      if (stack.length) stack[stack.length - 1]!.push(node);
      else if (!root) root = node;
      stack.push(node);
      i++;
    } else if (c === ")") {
      if (!stack.length) throw new Error("unbalanced ')' in s-expression");
      stack.pop();
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (!top) throw new Error("string outside a list in s-expression");
      top.push(unescapeQuoted(text.slice(i + 1, j)));
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !WS.has(text[j]!) && text[j] !== "(" && text[j] !== ")") j++;
      const top = stack[stack.length - 1];
      if (!top) throw new Error("atom outside a list in s-expression");
      top.push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length || !root) throw new Error("unbalanced '(' in s-expression");
  return root;
}

/** Child lists whose head is `key`. */
export function kids(node: SNode, key: string): SNode[] {
  const out: SNode[] = [];
  for (const c of node) if (Array.isArray(c) && c[0] === key) out.push(c);
  return out;
}

export function kid(node: SNode, key: string): SNode | undefined {
  for (const c of node) if (Array.isArray(c) && c[0] === key) return c;
  return undefined;
}

/**
 * A zone's keepout disallows any of `what` (footprints, tracks, vias, pads, copperpour). A rule area that allows
 * everything only scopes custom DRC rules (R1N's "BENCH ... landing" areas) and blocks nothing (toolkit
 * check_acceptance.keepout_blocks).
 */
export function keepoutBlocks(zone: SNode, what: string | string[] = "footprints"): boolean {
  const k = kid(zone, "keepout");
  if (!k) return false;
  const keys = Array.isArray(what) ? what : [what];
  return k.slice(1).some((x) => Array.isArray(x) && typeof x[0] === "string" && keys.includes(x[0]) && x[1] === "not_allowed");
}

/** Atoms of a node after its head, as strings (nested lists skipped). */
export function atoms(node: SNode | undefined): string[] {
  return node ? node.slice(1).filter((x): x is string => typeof x === "string") : [];
}

export function num(x: SItem | undefined, fallback = 0): number {
  const v = typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------------------------
// Round-trip-safe writing. Edits are splices on the original text: bytes that are not edited are never
// rewritten, so an edit-free write is the input byte for byte. `parseLossless`/`printLossless` give the same
// guarantee for a full parse tree (every token keeps the whitespace before it).
// ---------------------------------------------------------------------------------------------

export interface Span {
  start: number;
  end: number;
}

/**
 * Spans of the root's direct children that start with `key` followed by whitespace (the toolkit's
 * `block_pass.top_level` took a space or `\n`; any whitespace here, so `(via\r\n` on a CRLF board and `(via\t` count).
 * Works on multi- and single-line files; quoted strings may hold parentheses.
 */
export function topLevelSpans(text: string, key: string): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "(") {
      depth++;
      if (depth === 2 && text.startsWith(key, i + 1)) {
        const nx = text[i + 1 + key.length];
        if (nx !== undefined && WS.has(nx)) start = i;
      }
    } else if (ch === ")") {
      if (depth === 2 && start >= 0) {
        spans.push({ start, end: i + 1 });
        start = -1;
      }
      depth--;
    }
  }
  return spans;
}

/** Span of the list that opens at `open` (the index of its `(`). */
export function listSpanAt(text: string, open: number): Span {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j]!;
    if (c === '"') {
      j++;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { start: open, end: j + 1 };
    }
  }
  throw new Error("unbalanced '(' in s-expression");
}

/** Direct children (lists) of the list at `span`, as spans. */
export function childLists(text: string, span: Span): Span[] {
  const out: Span[] = [];
  let depth = 0;
  let start = -1;
  for (let i = span.start; i < span.end; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      i++;
      while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (ch === "(") {
      depth++;
      if (depth === 2) start = i;
    } else if (ch === ")") {
      if (depth === 2) out.push({ start, end: i + 1 });
      depth--;
    }
  }
  return out;
}

export interface TextEdit extends Span {
  text: string;
}

/** Apply non-overlapping splices (any order) to `text`, in one pass (per-edit rebuilding is quadratic on large boards). */
export function splice(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) throw new Error("overlapping text edits");
    parts.push(text.slice(at, e.start), e.text);
    at = e.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/**
 * Delete spans the way the toolkit does: trailing blanks before the span go with it, the line break stays. One pass
 * joining the kept pieces: removing spans one at a time rebuilt the whole text per span (minutes on an 86 MB board).
 * Overlapping spans are merged.
 */
export function removeSpans(text: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const s of sorted) {
    if (s.end <= at) continue; // inside a span already removed
    const start = Math.max(s.start, at);
    parts.push(text.slice(at, start).replace(/[ \t]+$/, ""));
    at = s.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** Quote an atom as a KiCad string. */
export function quote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

export interface LAtom {
  /** Whitespace before the token. */
  ws: string;
  /** The token exactly as written (quotes and escapes included). */
  raw: string;
  quoted: boolean;
}
export interface LList {
  ws: string;
  items: Array<LAtom | LList>;
  /** Whitespace before the closing parenthesis. */
  closeWs: string;
}

/** Lossless parse of the first list (and any trailing text, kept in `tail`). `printLossless` returns the input exactly. */
export function parseLossless(text: string): { root: LList; head: string; tail: string } {
  const stack: LList[] = [];
  let root: LList | null = null;
  let ws = "";
  let i = 0;
  const n = text.length;
  let head = "";
  let tailStart = n;
  while (i < n) {
    const c = text[i]!;
    if (WS.has(c)) {
      ws += c;
      i++;
    } else if (c === "(") {
      const node: LList = { ws, items: [], closeWs: "" };
      if (stack.length) stack[stack.length - 1]!.items.push(node);
      else if (!root) {
        root = node;
        head = ws;
        node.ws = "";
      }
      stack.push(node);
      ws = "";
      i++;
    } else if (c === ")") {
      const top = stack.pop();
      if (!top) throw new Error("unbalanced ')' in s-expression");
      top.closeWs = ws;
      ws = "";
      i++;
      if (!stack.length) {
        tailStart = i;
        break;
      }
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      stack[stack.length - 1]!.items.push({ ws, raw: text.slice(i, j + 1), quoted: true });
      ws = "";
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !WS.has(text[j]!) && text[j] !== "(" && text[j] !== ")") j++;
      if (!stack.length) throw new Error("atom outside a list in s-expression");
      stack[stack.length - 1]!.items.push({ ws, raw: text.slice(i, j), quoted: false });
      ws = "";
      i = j;
    }
  }
  if (stack.length || !root) throw new Error("unbalanced '(' in s-expression");
  return { root, head, tail: ws + text.slice(tailStart) };
}

export function printLossless(p: { root: LList; head: string; tail: string }): string {
  const out: string[] = [p.head];
  const walk = (l: LList) => {
    out.push(l.ws, "(");
    for (const it of l.items) {
      if ("items" in it) walk(it);
      else out.push(it.ws, it.raw);
    }
    out.push(l.closeWs, ")");
  };
  walk(p.root);
  out.push(p.tail);
  return out.join("");
}
