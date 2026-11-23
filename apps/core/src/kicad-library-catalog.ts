import { isManagedLibraryRow, type ProjectLibraryKind, type ProjectLibraryRow } from "./project-library-tables";
/** Project-independent search and inspection for the KiCad libraries bundled with Fabdesk. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FootprintHit,
  PartBounds,
  PartDescription,
  PartRoleSuitability,
} from "@fabdesk/tools";
import { rankPartSearch } from "./part-search-ranking";

type SExpr = string | SExpr[];
type CatalogKind = "footprint" | "symbol";
type CatalogIndexEntry = {
  path: string;
  description?: string | undefined;
  keywords?: string[] | undefined;
};

export class KicadLibraryCatalog {
  private footprintIndex?: Promise<Map<string, CatalogIndexEntry>>;
  private symbolIndex?: Promise<Map<string, CatalogIndexEntry>>;
  private parsed = new Map<string, Promise<SExpr[]>>();

  constructor(
    private readonly roots: { footprints?: string | undefined; symbols?: string | undefined },
  ) {}

  isBundledRow(kind: ProjectLibraryKind, row: ProjectLibraryRow): boolean {
    return isManagedLibraryRow(kind, row, this.roots);
  }

  has(kind: CatalogKind): boolean {
    return Boolean(kind === "footprint" ? this.roots.footprints : this.roots.symbols);
  }

  async search(kind: CatalogKind, query: string, limit: number): Promise<FootprintHit[]> {
    const index = await this.index(kind);
    const tokens = query
      .toLowerCase()
      .split(/[\s:_-]+/)
      .filter(Boolean);
    const roleQuery = tokens.some((token) => ["power", "charging", "usb", "typec"].includes(token));
    const seedTokens = tokens.filter(
      (token) => !["power", "only", "charging", "role"].includes(token),
    );
    if (!seedTokens.length && roleQuery) seedTokens.push("usb");
    const rankingQuery = seedTokens.join(" ");
    const candidates = rankPartSearch(
      rankingQuery,
      [...index.entries()].map(([libId, entry]) => {
        const [nickname, ...name] = libId.split(":");
        return {
          libId,
          nickname: nickname!,
          name: name.join(":"),
          description: entry.description,
          keywords: entry.keywords,
        };
      }),
    ).slice(0, Math.max(50, limit * 10));
    const enriched = await Promise.all(
      candidates.map(async (candidate) => {
        const { libId } = candidate;
        const part = await this.describe(kind, libId);
        const metadata =
          `${part?.description ?? ""} ${(part?.keywords ?? []).join(" ")}`.toLowerCase();
        const explicitPowerOnly = /power[- ]only|charging[- ]only/.test(
          `${libId} ${metadata}`.toLowerCase(),
        );
        const roleBoost =
          roleQuery && part?.roleSuitability?.some((role) => role.suitable)
            ? explicitPowerOnly
              ? 600_000
              : 100_000
            : 0;
        const [ranked] = rankPartSearch(rankingQuery, [
          {
            ...candidate,
            description: `${candidate.description ?? ""} ${part?.description ?? ""}`,
            keywords: [...(candidate.keywords ?? []), ...(part?.keywords ?? [])],
          },
        ]);
        return { libId, score: (ranked?.score ?? candidate.score) + roleBoost, part };
      }),
    );
    return enriched
      .sort((a, b) => b.score - a.score || a.libId.localeCompare(b.libId))
      .slice(0, limit)
      .map(({ libId, part }) => {
        const [nickname, ...name] = libId.split(":");
        return {
          libId,
          nickname: nickname!,
          name: name.join(":"),
          description: part?.description ?? "",
          ...(part ? { part } : {}),
        };
      });
  }

  async describe(kind: CatalogKind, libId: string): Promise<PartDescription | null> {
    const entry = (await this.index(kind)).get(libId);
    if (!entry) return null;
    const [nickname, ...parts] = libId.split(":");
    const name = parts.join(":");
    if (!nickname || !name) return null;
    const root = await this.parse(entry.path);
    if (kind === "footprint") return describeFootprint(libId, root);
    return describeSymbol(libId, root, name);
  }

  private async index(kind: CatalogKind): Promise<Map<string, CatalogIndexEntry>> {
    if (kind === "footprint") return (this.footprintIndex ??= this.indexFootprints());
    return (this.symbolIndex ??= this.indexSymbols());
  }

  private async indexFootprints(): Promise<Map<string, CatalogIndexEntry>> {
    const result = new Map<string, CatalogIndexEntry>();
    const root = this.roots.footprints;
    if (!root) return result;
    for (const library of await readdir(root, { withFileTypes: true })) {
      if (!library.isDirectory() || !library.name.endsWith(".pretty")) continue;
      const nickname = library.name.slice(0, -".pretty".length);
      const dir = join(root, library.name);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".kicad_mod"))
          result.set(`${nickname}:${entry.name.slice(0, -".kicad_mod".length)}`, {
            path: join(dir, entry.name),
          });
      }
    }
    return result;
  }

  private async indexSymbols(): Promise<Map<string, CatalogIndexEntry>> {
    const result = new Map<string, CatalogIndexEntry>();
    const root = this.roots.symbols;
    if (!root) return result;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".kicad_sym")) continue;
      const nickname = entry.name.slice(0, -".kicad_sym".length);
      const path = join(root, entry.name);
      const text = await readFile(path, "utf8");
      for (const symbol of topLevelSymbolEntries(text))
        result.set(`${nickname}:${symbol.name}`, {
          path,
          description: symbol.description,
          keywords: symbol.keywords,
        });
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

function topLevelSymbolEntries(
  text: string,
): Array<{ name: string; description?: string; keywords?: string[] }> {
  const symbols: Array<{ name: string; description?: string; keywords?: string[] }> = [];
  const tokens = tokenize(text);
  let current: { name: string; description?: string; keywords?: string[] } | undefined;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]!.depth === 2 && tokens[i]!.value === "symbol" && tokens[i + 1]!.depth === 2) {
      current = { name: tokens[i + 1]!.value };
      symbols.push(current);
      continue;
    }
    if (!current || tokens[i]!.depth !== 3 || tokens[i]!.value !== "property") continue;
    const property = tokens[i + 1];
    const value = tokens[i + 2];
    if (property?.depth !== 3 || value?.depth !== 3) continue;
    if (["Description", "description", "ki_description"].includes(property.value))
      current.description = value.value;
    if (["Keywords", "keywords", "ki_keywords"].includes(property.value))
      current.keywords = value.value.split(/\s+/).filter(Boolean);
  }
  return symbols;
}

function describeFootprint(libId: string, root: SExpr[]): PartDescription | null {
  const footprint = find(root, "footprint");
  if (!footprint) return null;
  const description = atom(child(footprint, "descr"), 1) ?? "";
  const keywords = (atom(child(footprint, "tags"), 1) ?? "").split(/\s+/).filter(Boolean);
  const pads = children(footprint, "pad").map((pad) => {
    const at = child(pad, "at");
    const size = child(pad, "size");
    return {
      number: atom(pad, 1) ?? "",
      type: atom(pad, 2) ?? "",
      shape: atom(pad, 3) ?? "",
      layers:
        child(pad, "layers")
          ?.slice(1)
          .filter((value): value is string => typeof value === "string") ?? [],
      position: { x: number(at, 1), y: number(at, 2) },
      size: { x: number(size, 1), y: number(size, 2) },
    };
  });
  const attr =
    child(footprint, "attr")
      ?.slice(1)
      .filter((value): value is string => typeof value === "string") ?? [];
  const padTypes = new Set(pads.map((pad) => pad.type));
  const assemblyMethod = attr.includes("smd")
    ? "smd"
    : attr.includes("through_hole")
      ? "through-hole"
      : padTypes.has("smd") && [...padTypes].some((type) => type.includes("thru_hole"))
        ? "mixed"
        : "unspecified";
  const bodyBounds = layerBounds(footprint, ["F.Fab", "B.Fab"]);
  const courtyardBounds = layerBounds(footprint, ["F.CrtYd", "B.CrtYd"]);
  const edgeText = children(footprint, "fp_text").find((entry) =>
    /pcb\s*edge/i.test(`${atom(entry, 1) ?? ""} ${atom(entry, 2) ?? ""}`),
  );
  const edgeAt = child(edgeText, "at");
  const models = children(footprint, "model")
    .map((model) => atom(model, 1) ?? "")
    .filter(Boolean);
  const datasheet = firstUrl(description);
  const excludedBom = attr.includes("exclude_from_bom");
  const excludedPosition = attr.includes("exclude_from_pos_files");
  return {
    kind: "footprint",
    libId,
    description,
    keywords,
    ...(datasheet ? { datasheet } : {}),
    roleSuitability: [
      usbPowerRole(
        libId,
        description,
        keywords,
        pads.map((pad) => pad.number),
      ),
    ],
    anchor: { x: 0, y: 0 },
    pads,
    package: {
      assemblyMethod,
      ...(bodyBounds ? { bodyBounds } : {}),
      ...(courtyardBounds ? { courtyardBounds } : {}),
      ...(edgeAt
        ? {
            connectorEdgeDatum: {
              axis: "y",
              coordinate: number(edgeAt, 2),
              label: atom(edgeText, 2) ?? "PCB Edge",
            },
          }
        : {}),
    },
    fabrication: {
      courtyard: courtyardBounds ? "available" : "missing",
      fabOutline: bodyBounds ? "available" : "missing",
      threeDModels: models.length ? "available" : "missing",
      models,
      includedInBom: !excludedBom,
      includedInPositionFiles: !excludedPosition,
    },
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
  const datasheet = children(symbol, "property").find((entry) => atom(entry, 1) === "Datasheet");
  const datasheetUrl = atom(datasheet, 2);
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
    ...(datasheetUrl ? { datasheet: datasheetUrl } : {}),
    pins: unique,
    roleSuitability: [
      usbPowerRole(
        libId,
        atom(description, 2) ?? "",
        [],
        unique.map((pin) => `${pin.number}:${pin.name}`),
      ),
    ],
  };
}

function firstUrl(value: string): string | undefined {
  return /https?:\/\/[^\s,)]+/.exec(value)?.[0];
}

function usbPowerRole(
  libId: string,
  description: string,
  keywords: string[],
  pins: string[],
): PartRoleSuitability {
  const text = `${libId} ${description} ${keywords.join(" ")}`.toLowerCase();
  const pinText = pins.join(" ").toLowerCase();
  const usb = /usb|type[-_ ]?c/.test(text);
  const powerOnly = /power[-_ ]?only|charging[-_ ]?only/.test(text);
  const hasVbus = /vbus|[ab]9/.test(pinText);
  const hasGround = /gnd|[ab]12/.test(pinText);
  const hasCc = /cc[12]|[ab]5/.test(pinText);
  const suitable =
    usb && ((powerOnly && hasVbus && hasGround && hasCc) || (hasVbus && hasGround && hasCc));
  const reasons = [
    usb ? "identified as USB-C" : "not identified as USB-C",
    hasVbus ? "VBUS pins/pads present" : "VBUS pins/pads not identified",
    hasGround ? "ground pins/pads present" : "ground pins/pads not identified",
    hasCc ? "CC1/CC2 pins/pads present" : "CC pins/pads not identified",
    ...(powerOnly ? ["library metadata marks the package power-only"] : []),
  ];
  return { role: "power-only-usb-c", suitable, reasons };
}

function layerBounds(root: SExpr[], layers: string[]): PartBounds | undefined {
  const points: Array<{ x: number; y: number }> = [];
  for (const value of root) {
    if (!Array.isArray(value) || typeof value[0] !== "string" || !value[0].startsWith("fp_"))
      continue;
    const layer = atom(child(value, "layer"), 1);
    if (!layer || !layers.includes(layer)) continue;
    for (const name of ["start", "end", "mid", "center", "xy"])
      for (const point of descendants(value, name))
        points.push({ x: number(point, 1), y: number(point, 2) });
  }
  if (!points.length) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const min = { x: Math.min(...xs), y: Math.min(...ys) };
  const max = { x: Math.max(...xs), y: Math.max(...ys) };
  return { min, max, size: { x: max.x - min.x, y: max.y - min.y } };
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
