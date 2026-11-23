import type { ClassifiedFile, LayerKind, LayerSide, PackageFile } from "./types";

const GERBER_EXT = /\.(gbr|gtl|gbl|gto|gbo|gts|gbs|gtp|gbp|gko|gm[0-9]|g[1-9][0-9]?)$/i;
const DRILL_EXT = /\.(drl|xln|txt)$/i;

export function isGerberName(name: string): boolean {
  const base = basename(name);
  if (/\.gbrjob$/i.test(base)) return false;
  return GERBER_EXT.test(base);
}

export function isDrillName(name: string): boolean {
  const base = basename(name);
  if (/map/i.test(base) && /\.(pdf|svg|png)$/i.test(base)) return false;
  if (/positions?|bom|cpl|pnp|pick/i.test(base) && /\.csv$/i.test(base)) return false;
  return DRILL_EXT.test(base) || /drill/i.test(base);
}

export function isBomName(name: string): boolean {
  return /bom/i.test(basename(name)) && /\.(csv|tsv|xls)$/i.test(name);
}

export function isPosName(name: string): boolean {
  return /(pos|position|cpl|pnp|pick)/i.test(basename(name)) && /\.(csv|pos)$/i.test(name);
}

export function classifyFile(file: PackageFile): ClassifiedFile {
  const name = file.name.replace(/\\/g, "/");
  const body = decodeText(file.bytes);
  const fromFn = classifyFileFunction(body);
  const fromName = classifyFilename(name);
  const kind = fromFn?.kind ?? fromName.kind;
  const side = fromFn?.side ?? fromName.side;
  return {
    name,
    kind,
    side,
    ...(fromFn?.copperIndex ?? fromName.copperIndex
      ? { copperIndex: fromFn?.copperIndex ?? fromName.copperIndex }
      : {}),
    body,
    bytes: file.bytes,
  };
}

export function classifyFilename(name: string): {
  kind: LayerKind;
  side: LayerSide;
  copperIndex?: number;
} {
  const n = basename(name).toLowerCase();
  if (isDrillName(name)) return { kind: "drill", side: /npth|np\.|non[-_ ]?plated/i.test(n) ? "none" : "both" };
  if (/edge[-_.]?cuts|profile|outline|gko|gm1/.test(n)) return { kind: "outline", side: "none" };
  if (/silk|legend|gto|gbo/.test(n))
    return { kind: "silk", side: sideOf(n, /gto|f[-_.]?silk|top/.test(n), /gbo|b[-_.]?silk|bot/.test(n)) };
  if (/paste|gtp|gbp/.test(n))
    return { kind: "paste", side: sideOf(n, /gtp|f[-_.]?paste|top/.test(n), /gbp|b[-_.]?paste|bot/.test(n)) };
  if (/mask|gts|gbs/.test(n))
    return { kind: "mask", side: sideOf(n, /gts|f[-_.]?mask|top/.test(n), /gbs|b[-_.]?mask|bot/.test(n)) };
  const inner = /in(?:ner)?[-_]?(\d+)/.exec(n) ?? /[-_.]g([1-9]\d?)/.exec(n);
  if (inner) return { kind: "copper", side: "inner", copperIndex: Number(inner[1]) + 1 };
  if (/f[-_.]?cu|gtl|copper,l1|top[-_.]?cu/.test(n)) return { kind: "copper", side: "top", copperIndex: 1 };
  if (/b[-_.]?cu|gbl|bot[-_.]?cu/.test(n)) return { kind: "copper", side: "bottom" };
  if (isGerberName(name)) return { kind: "other", side: "none" };
  return { kind: "other", side: "none" };
}

export function classifyFileFunction(body: string): {
  kind: LayerKind;
  side: LayerSide;
  copperIndex?: number;
} | null {
  const m =
    /%TF\.FileFunction,([^*%]+)\*%/.exec(body) ?? /TF\.FileFunction,([^*%*\n]+)/.exec(body);
  if (!m) return null;
  const parts = (m[1] ?? "").split(",").map((s) => s.trim());
  const head = (parts[0] ?? "").toLowerCase();
  if (head === "copper") {
    const layer = parts.find((p) => /^L\d+/i.test(p));
    const n = layer ? Number(layer.slice(1)) : undefined;
    const sideTok = (parts[2] ?? parts[1] ?? "").toLowerCase();
    const side: LayerSide = /bot/.test(sideTok) ? "bottom" : /in/.test(sideTok) ? "inner" : "top";
    return { kind: "copper", side, ...(n ? { copperIndex: n } : {}) };
  }
  if (head === "soldermask" || head === "mask")
    return { kind: "mask", side: sideToken(parts[1]) };
  if (head === "paste") return { kind: "paste", side: sideToken(parts[1]) };
  if (head === "legend" || head === "silkscreen") return { kind: "silk", side: sideToken(parts[1]) };
  if (head === "profile" || head === "outline") return { kind: "outline", side: "none" };
  if (head === "plated" || head === "nonplated" || head === "drill")
    return { kind: "drill", side: "both" };
  return null;
}

function sideToken(value: string | undefined): LayerSide {
  const v = (value ?? "").toLowerCase();
  if (/bot/.test(v)) return "bottom";
  if (/top/.test(v)) return "top";
  return "none";
}

function sideOf(name: string, top: boolean, bottom: boolean): LayerSide {
  if (top && !bottom) return "top";
  if (bottom && !top) return "bottom";
  if (/^b[-_.]/.test(name) || name.includes("bottom")) return "bottom";
  if (/^f[-_.]/.test(name) || name.includes("top")) return "top";
  return "none";
}

export function basename(path: string): string {
  const n = path.replace(/\\/g, "/");
  return n.slice(n.lastIndexOf("/") + 1);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
