/** Bounded KiCad s-expression reader for system diagrams. Never evaluates file content. */

export type Atom = string;
export type List = Sexpr[];
export type Sexpr = Atom | List;

export function isList(node: Sexpr): node is List {
  return Array.isArray(node);
}

export function head(node: Sexpr): string | undefined {
  return isList(node) && typeof node[0] === "string" ? node[0] : undefined;
}

export function children(node: List, key: string): List[] {
  return node.filter((item): item is List => isList(item) && item[0] === key);
}

export function child(node: List, key: string): List | undefined {
  return children(node, key)[0];
}

export function atom(node: List, key: string): string {
  const value = child(node, key)?.[1];
  return typeof value === "string" ? value : "";
}

export function property(node: List, key: string): string {
  const hit = children(node, "property").find((item) => item[1] === key);
  return typeof hit?.[2] === "string" ? hit[2] : "";
}

/** Same tokenizer as native part selection: quoted strings, atoms, bounded nesting. */
export function parseSexpr(text: string, kind: string): List {
  if (text.length > 20_000_000) throw new Error("Design is too large for a system diagram.");
  const stack: List[] = [[]];
  const tokens = /\s*("(?:\\.|[^"\\])*"|[()]|[^\s()"]+)\s*/gy;
  let offset = 0;
  let count = 0;
  while (offset < text.length) {
    tokens.lastIndex = offset;
    const match = tokens.exec(text);
    if (!match) {
      if (!text.slice(offset).trim()) break;
      throw new Error("Malformed native design.");
    }
    offset = tokens.lastIndex;
    const token = match[1]!;
    if (++count > 2_000_000) throw new Error("Design exceeds the system-diagram limit.");
    if (token === "(") {
      if (stack.length > 128) throw new Error("Native design nesting exceeds the system-diagram limit.");
      const node: List = [];
      stack.at(-1)!.push(node);
      stack.push(node);
    } else if (token === ")") {
      if (stack.length === 1) throw new Error("Malformed native design.");
      stack.pop();
    } else {
      stack.at(-1)!.push(token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, "$1") : token);
    }
  }
  const root = stack[0]![0];
  if (stack.length !== 1 || stack[0]!.length !== 1 || root === undefined || !isList(root) || root[0] !== kind) {
    throw new Error("Malformed native design.");
  }
  return root;
}
