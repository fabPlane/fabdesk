/**
 * Extract per-page text from a PDF without executing document scripts.
 * Covers uncompressed and FlateDecode content streams; CID / scanned pages return empty text.
 */
import { inflateSync } from "node:zlib";

export type PdfPageText = { page: number; text: string };

const MAX_PDF_BYTES = 25 * 1024 * 1024;

function decodeLiteral(raw: string): string {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function decodeHex(raw: string): string {
  const hex = raw.replace(/\s+/g, "");
  if (hex.startsWith("feff") || hex.startsWith("FEFF")) {
    const units: number[] = [];
    for (let i = 4; i + 3 < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  }
  let out = "";
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2) || "00", 16));
  return out;
}

function extractOperators(content: string): string {
  const chunks: string[] = [];
  const tj = /\((?:\\.|[^\\)])*\)\s*Tj|\((?:\\.|[^\\)])*\)\s*'|<([0-9A-Fa-f \n\r\t]+)>\s*Tj|\[(.*?)\]\s*TJ/gs;
  for (const match of content.matchAll(tj)) {
    const whole = match[0];
    if (match[1] !== undefined) {
      chunks.push(decodeHex(match[1]));
      continue;
    }
    if (whole.endsWith("TJ")) {
      const inner = match[2] ?? "";
      for (const piece of inner.matchAll(/\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f \n\r\t]+)>/g)) {
        if (piece[1] !== undefined) chunks.push(decodeHex(piece[1]));
        else chunks.push(decodeLiteral(piece[0].slice(1, -1)));
      }
      chunks.push(" ");
      continue;
    }
    const literal = whole.match(/\((?:\\.|[^\\)])*\)/);
    if (literal) chunks.push(decodeLiteral(literal[0].slice(1, -1)));
    chunks.push(whole.endsWith("'") ? "\n" : "");
  }
  return chunks.join("").replace(/[ \t]+\n/g, "\n").replace(/\s+/g, " ").trim();
}

function decodeStream(dict: string, body: Uint8Array): string {
  const filters = [...dict.matchAll(/\/FlateDecode/g)];
  let bytes = body;
  for (const _ of filters) {
    try {
      bytes = inflateSync(bytes);
    } catch {
      return "";
    }
  }
  return Buffer.from(bytes).toString("latin1");
}

function objects(bytes: Uint8Array): Map<string, { dict: string; stream: Uint8Array | null }> {
  const src = Buffer.from(bytes).toString("latin1");
  const found = new Map<string, { dict: string; stream: Uint8Array | null }>();
  const re = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
  for (const match of src.matchAll(re)) {
    const id = `${match[1]} ${match[2]}`;
    const body = match[3] ?? "";
    const streamAt = body.search(/\sstream\r?\n/);
    if (streamAt < 0) {
      found.set(id, { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    const after = body.slice(streamAt).replace(/^\sstream\r?\n/, "");
    const end = after.lastIndexOf("endstream");
    const payload = end >= 0 ? after.slice(0, end) : after;
    found.set(id, { dict, stream: Buffer.from(payload, "latin1") });
  }
  return found;
}

function resolveContents(dict: string, objs: Map<string, { dict: string; stream: Uint8Array | null }>): string {
  const ref = /\/Contents\s+(\d+)\s+(\d+)\s+R/.exec(dict);
  if (ref) {
    const obj = objs.get(`${ref[1]} ${ref[2]}`);
    if (!obj?.stream) return "";
    return decodeStream(obj.dict, obj.stream);
  }
  const array = /\/Contents\s*\[([^\]]+)\]/.exec(dict);
  if (!array) return "";
  const parts: string[] = [];
  for (const item of array[1]!.matchAll(/(\d+)\s+(\d+)\s+R/g)) {
    const obj = objs.get(`${item[1]} ${item[2]}`);
    if (obj?.stream) parts.push(decodeStream(obj.dict, obj.stream));
  }
  return parts.join("\n");
}

function kidRefs(dict: string): string[] {
  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict);
  if (!kids?.[1]) return [];
  return [...kids[1].matchAll(/(\d+)\s+(\d+)\s+R/g)].map((item) => `${item[1]} ${item[2]}`);
}

function catalogPages(
  objs: Map<string, { dict: string; stream: Uint8Array | null }>,
): Array<{ dict: string; stream: Uint8Array | null }> {
  let catalog: { dict: string; stream: Uint8Array | null } | undefined;
  for (const obj of objs.values()) {
    if (/\/Type\s*\/Catalog\b/.test(obj.dict)) {
      catalog = obj;
      break;
    }
  }
  const rootRef = catalog ? /\/Pages\s+(\d+)\s+(\d+)\s+R/.exec(catalog.dict) : null;
  const walk = (id: string | undefined, depth: number): Array<{ dict: string; stream: Uint8Array | null }> => {
    if (!id || depth > 32) return [];
    const obj = objs.get(id);
    if (!obj) return [];
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      return kidRefs(obj.dict).flatMap((kid) => walk(kid, depth + 1));
    }
    if (/\/Type\s*\/Page\b/.test(obj.dict)) return [obj];
    return [];
  };
  const fromTree = walk(rootRef ? `${rootRef[1]} ${rootRef[2]}` : undefined, 0);
  if (fromTree.length) return fromTree;
  return [...objs.values()].filter(
    (obj) => /\/Type\s*\/Page\b/.test(obj.dict) && !/\/Type\s*\/Pages\b/.test(obj.dict),
  );
}

/** Return page-ordered extractable text. Encrypted or image-only PDFs yield empty pages. */
export function extractPdfPageText(data: Uint8Array): PdfPageText[] {
  if (data.byteLength > MAX_PDF_BYTES) return [];
  const head = Buffer.from(data.subarray(0, 8)).toString("latin1");
  if (!head.startsWith("%PDF-")) return [];
  const objs = objects(data);
  return catalogPages(objs).map((obj, index) => ({
    page: index + 1,
    text: extractOperators(resolveContents(obj.dict, objs)),
  }));
}

export function pdfPageCount(data: Uint8Array): number | null {
  const pages = extractPdfPageText(data);
  return pages.length > 0 ? pages.length : null;
}
