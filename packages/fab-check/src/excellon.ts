import type { Point } from "./types";

export type DrillHit = Point & {
  diameterMm: number;
  plated: boolean | null;
  slot?: { x2: number; y2: number };
};

export type ParsedExcellon = {
  unit: "mm" | "in" | null;
  zeros: "leading" | "trailing" | "decimal" | null;
  tools: Array<{ id: string; diameterMm: number }>;
  hits: DrillHit[];
  plated: boolean | null;
};

const DEFAULT_DIGITS = { int: 3, frac: 3 };

/** Parse a common Excellon drill file (KiCad / metric / inch, TZ or LZ). */
export function parseExcellon(text: string, plated: boolean | null = null): ParsedExcellon {
  const tools: ParsedExcellon["tools"] = [];
  const hits: DrillHit[] = [];
  let unit: ParsedExcellon["unit"] = null;
  let zeros: ParsedExcellon["zeros"] = null;
  let header = true;
  let current: { id: string; diameterMm: number } | null = null;
  let last: Point = { x: 0, y: 0 };
  let filePlated = plated;
  const digits = { ...DEFAULT_DIGITS };

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) {
      if (/METRIC|INCH/i.test(line) && /FORMAT/i.test(line)) {
        const fmt = /\{[^}]*\/\s*(metric|inch)\s*\/\s*(decimal)?/i.exec(line);
        if (fmt) {
          unit = fmt[1]?.toLowerCase() === "inch" ? "in" : "mm";
          if (fmt[2]) zeros = "decimal";
        }
      }
      if (/non[- ]?plated/i.test(line)) filePlated = false;
      if (/\bplated\b/i.test(line) && !/non[- ]?plated/i.test(line)) filePlated = true;
      continue;
    }
    if (line === "%" || line === "M95") {
      header = false;
      continue;
    }
    if (/^METRIC/i.test(line)) {
      unit = "mm";
      if (/TZ/.test(line)) zeros = "trailing";
      if (/LZ/.test(line)) zeros = "leading";
      continue;
    }
    if (/^INCH/i.test(line)) {
      unit = "in";
      if (/TZ/.test(line)) zeros = "trailing";
      if (/LZ/.test(line)) zeros = "leading";
      continue;
    }
    const toolDef = /^T(\d+)\s*C([0-9.]+)/i.exec(line);
    if (toolDef) {
      const diameter = Number(toolDef[2]);
      tools.push({
        id: toolDef[1] ?? "",
        diameterMm: (unit === "in" ? diameter * 25.4 : diameter) || 0,
      });
      continue;
    }
    const toolSel = /^T(\d+)\s*$/i.exec(line);
    if (toolSel) {
      current = tools.find((t) => t.id === toolSel[1]) ?? null;
      continue;
    }
    if (/^M30/i.test(line) || /^M00/i.test(line)) continue;
    if (/^G9[05]/i.test(line) || /^G05/i.test(line) || /^FMAT/i.test(line)) continue;
    const slot = /G85/.test(line);
    const xm = /X(-?[0-9.]+)/.exec(line);
    const ym = /Y(-?[0-9.]+)/.exec(line);
    if (!xm && !ym) continue;
    const x = xm ? parseDrillCoord(xm[1] ?? "0", digits, zeros) : last.x;
    const y = ym ? parseDrillCoord(ym[1] ?? "0", digits, zeros) : last.y;
    const scale = unit === "in" ? 25.4 : 1;
    const point = { x: x * scale, y: y * scale };
    if (slot) {
      const rest = line.slice(line.indexOf("G85") + 3);
      const x2m = /X(-?[0-9.]+)/.exec(rest);
      const y2m = /Y(-?[0-9.]+)/.exec(rest);
      const x2 = x2m ? parseDrillCoord(x2m[1] ?? "0", digits, zeros) * scale : point.x;
      const y2 = y2m ? parseDrillCoord(y2m[1] ?? "0", digits, zeros) * scale : point.y;
      hits.push({
        ...point,
        diameterMm: current?.diameterMm ?? 0,
        plated: filePlated,
        slot: { x2, y2 },
      });
      last = { x: x2 / scale, y: y2 / scale };
    } else {
      hits.push({ ...point, diameterMm: current?.diameterMm ?? 0, plated: filePlated });
      last = { x, y };
    }
    header = header && false;
  }
  return { unit, zeros, tools, hits, plated: filePlated };
}

function parseDrillCoord(
  raw: string,
  digits: { int: number; frac: number },
  zeros: ParsedExcellon["zeros"],
): number {
  if (raw.includes(".")) return Number(raw);
  const neg = raw.startsWith("-");
  const digitsOnly = neg ? raw.slice(1) : raw;
  if (zeros === "leading") {
    const padded = digitsOnly.padEnd(digits.int + digits.frac, "0");
    const n = Number(padded) / 10 ** digits.frac;
    return neg ? -n : n;
  }
  const n = Number(digitsOnly) / 10 ** digits.frac;
  return neg ? -n : n;
}
