/** Project-independent search and inspection for the KiCad libraries bundled with Fabdesk. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FootprintHit, PartDescription } from "@fabdesk/tools";

type SExpr = string | SExpr[];
type CatalogKind = "footprint" | "symbol";

export class KicadLibraryCatalog {
  private footprintIndex?: Promise<Map<string, string>>;
  private symbolIndex?: Promise<Map<string, string>>;
  private parsed = new Map<string, Promise<SExpr[]>>();

  constructor(
    private readonly roots: { footprints?: string | undefined; symbols?: string | undefined },
  ) {}

  has(kind: CatalogKind): boolean {
    return Boolean(kind === "footprint" ? this.roots.footprints : this.roots.symbols);
  }

  async search(kind: CatalogKind, query: string, limit: number): Promise<FootprintHit[]> {
    const index = await this.index(kind);
    const tokens = query
      .toLowerCase()
      .split(/[\s:_-]+/)
      .filter(Boolean);
    return [...index.entries()]
      .map(([libId, path]) => {
        const haystack = libId.toLowerCase();
        const matched = tokens.filter((token) => haystack.includes(token)).length;
        const exact = haystack === query.toLowerCase() ? 100 : 0;
        const prefix = haystack.startsWith(query.toLowerCase()) ? 20 : 0;
        return { libId, path, score: exact + prefix + matched };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.libId.localeCompare(b.libId))
      .slice(0, limit)
      .map(({ libId }) => {
        const [nickname, ...name] = libId.split(":");
        return {
          libId,
          nickname: nickname!,
          name: name.join(":"),
          description: "Bundled KiCad library",
        };
      });
  }

  async describe(kind: CatalogKind, libId: string): Promise<PartDescription | null> {
    const path = (await this.index(kind)).get(libId);
    if (!path) return null;
    const [nickname, ...parts] = libId.split(":");
    const name = parts.join(":");
    if (!nickname || !name) return null;
    const root = await this.parse(path);
    if (kind === "footprint") return describeFootprint(libId, root);
    return describeSymbol(libId, root, name);
  }

  private async index(kind: CatalogKind): Promise<Map<string, string>> {
    if (kind === "footprint") return (this.footprintIndex ??= this.indexFootprints());
    return (this.symbolIndex ??= this.indexSymbols());
  }

  private async indexFootprints(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const root = this.roots.footprints;
    if (!root) return result;
    for (const library of await readdir(root, { withFileTypes: true })) {
      if (!library.isDirectory() || !library.name.endsWith(".pretty")) continue;
      const nickname = library.name.slice(0, -".pretty".length);
      const dir = join(root, library.name);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".kicad_mod"))
          result.set(
            `${nickname}:${entry.name.slice(0, -".kicad_mod".length)}`,
            join(dir, entry.name),
          );
      }
    }
    return result;
  }

  private async indexSymbols(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const root = this.roots.symbols;
    if (!root) return result;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".kicad_sym")) continue;
      const nickname = entry.name.slice(0, -".kicad_sym".length);
      const path = join(root, entry.name);
      const text = await readFile(path, "utf8");
      for (const name of topLevelSymbolNames(text)) result.set(`${nickname}:${name}`, path);
    }
    return result;
  }

  private parse(path: string): Promise<SExpr[]> {
    let value = this.parsed.get(path);
    if (!value) {
      value = readFile(path, "utf8").then(parseSExpr);
      this.parsed.set(path, value);
    }
    return value;
  }
}

function topLevelSymbolNames(text: string): string[] {
  const names: string[] = [];
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length - 1; i++)
    if (tokens[i]!.depth === 2 && tokens[i]!.value === "symbol" && tokens[i + 1]!.depth === 2)
      names.push(tokens[i + 1]!.value);
  return names;
}

function describeFootprint(libId: string, root: SExpr[]): PartDescription | null {
  const footprint = find(root, "footprint");
  if (!footprint) return null;
  return {
    kind: "footprint",
    libId,
    description: atom(child(footprint, "descr"), 1) ?? "",
    anchor: { x: 0, y: 0 },
    pads: children(footprint, "pad").map((pad) => {
      const at = child(pad, "at");
      const size = child(pad, "size");
      return {
        number: atom(pad, 1) ?? "",
        position: { x: number(at, 1), y: number(at, 2) },
        size: { x: number(size, 1), y: number(size, 2) },
      };
    }),
  };
}

function describeSymbol(libId: string, root: SExpr[], name: string): PartDescription | null {
  const library = find(root, "kicad_symbol_lib") ?? root;
  let symbol = children(library, "symbol").find((entry) => atom(entry, 1) === name);
  if (!symbol) return null;
  const base = atom(child(symbol, "extends"), 1);
  if (base)
    symbol = mergeSymbol(
      children(library, "symbol").find((entry) => atom(entry, 1) === base),
      symbol,
    );
  const description = children(symbol, "property").find(
    (entry) => atom(entry, 1) === "Description",
  );
  const pins = descendants(symbol, "pin").map((pin) => {
    const at = child(pin, "at");
    const electrical = atom(pin, 1) ?? "unspecified";
    return {
      number: atom(child(pin, "number"), 1) ?? "",
      name: atom(child(pin, "name"), 1) ?? "",
      electricalType: electricalType(electrical),
      position: { x: number(at, 1), y: number(at, 2) },
    };
  });
  const unique = [...new Map(pins.map((pin) => [`${pin.number}\0${pin.name}`, pin])).values()];
  return {
    kind: "symbol",
    libId,
    description: atom(description, 2) ?? "",
    pins: unique,
  };
}

function mergeSymbol(base: SExpr[] | undefined, derived: SExpr[]): SExpr[] {
  return base ? [...base, ...derived.slice(2)] : derived;
}

function electricalType(value: string): string {
  const names: Record<string, string> = {
    input: "PT_INPUT",
    output: "PT_OUTPUT",
    bidirectional: "PT_BIDI",
    tri_state: "PT_TRISTATE",
    passive: "PT_PASSIVE",
    free: "PT_FREE",
    unspecified: "PT_UNSPECIFIED",
    power_in: "PT_POWER_IN",
    power_out: "PT_POWER_OUT",
    open_collector: "PT_OPEN_COLLECTOR",
    open_emitter: "PT_OPEN_EMITTER",
    no_connect: "PT_NC",
  };
  return names[value] ?? value;
}

function find(root: SExpr[], name: string): SExpr[] | undefined {
  for (const value of root) {
    if (Array.isArray(value)) {
      if (value[0] === name) return value;
      const nested = find(value, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function child(root: SExpr[] | undefined, name: string): SExpr[] | undefined {
  return root?.find((value): value is SExpr[] => Array.isArray(value) && value[0] === name);
}

function children(root: SExpr[] | undefined, name: string): SExpr[][] {
  return root?.filter((value): value is SExpr[] => Array.isArray(value) && value[0] === name) ?? [];
}

function descendants(root: SExpr[] | undefined, name: string): SExpr[][] {
  const result: SExpr[][] = [];
  for (const value of root ?? []) {
    if (!Array.isArray(value)) continue;
    if (value[0] === name) result.push(value);
    else result.push(...descendants(value, name));
  }
  return result;
}

function atom(root: SExpr[] | undefined, index: number): string | undefined {
  const value = root?.[index];
  return typeof value === "string" ? value : undefined;
}

function number(root: SExpr[] | undefined, index: number): number {
  const value = Number(atom(root, index) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  for (const token of tokenize(text)) {
    if (token.value === "(") {
      const list: SExpr[] = [];
      stack.at(-1)!.push(list);
      stack.push(list);
    } else if (token.value === ")") {
      if (stack.length === 1) throw new SyntaxError("unexpected closing parenthesis");
      stack.pop();
    } else stack.at(-1)!.push(token.value);
  }
  if (stack.length !== 1) throw new SyntaxError("unterminated S-expression");
  return root;
}

function tokenize(text: string): Array<{ value: string; depth: number }> {
  const result: Array<{ value: string; depth: number }> = [];
  let depth = 0;
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === ";") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "(" || c === ")") {
      if (c === "(") depth++;
      result.push({ value: c, depth });
      if (c === ")") depth--;
      i++;
      continue;
    }
    if (c === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        value += text[i++]!;
      }
      i++;
      result.push({ value, depth });
      continue;
    }
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i]!)) i++;
    result.push({ value: text.slice(start, i), depth });
  }
  return result;
}
