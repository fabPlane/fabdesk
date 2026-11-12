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

/** Atoms of a node after its head, as strings (nested lists skipped). */
export function atoms(node: SNode | undefined): string[] {
  return node ? node.slice(1).filter((x): x is string => typeof x === "string") : [];
}

export function num(x: SItem | undefined, fallback = 0): number {
  const v = typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(v) ? v : fallback;
}
