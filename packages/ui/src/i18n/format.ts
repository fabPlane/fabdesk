/**
 * Small ICU subset: `{name}`, `{count, plural, one {…} other {…}}`, `{val, select, a {…} other {…}}`.
 * `#` inside a plural arm is the formatted count. Nested messages are formatted recursively.
 */

export type FormatValues = Record<string, string | number | boolean | undefined>;

export function formatMessage(template: string, values: FormatValues = {}, locale = "en"): string {
  return replaceTokens(template, values, locale);
}

function replaceTokens(template: string, values: FormatValues, locale: string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const start = template.indexOf("{", i);
    if (start < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, start);
    const end = matchingBrace(template, start);
    if (end < 0) {
      out += template.slice(start);
      break;
    }
    out += formatToken(template.slice(start + 1, end), values, locale);
    i = end + 1;
  }
  return out;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function formatToken(body: string, values: FormatValues, locale: string): string {
  const comma = indexOfTopComma(body);
  if (comma < 0) {
    const name = body.trim();
    const value = values[name];
    return value === undefined ? `{${name}}` : String(value);
  }
  const name = body.slice(0, comma).trim();
  const rest = body.slice(comma + 1);
  const comma2 = indexOfTopComma(rest);
  const type = (comma2 < 0 ? rest : rest.slice(0, comma2)).trim();
  const arms = comma2 < 0 ? "" : rest.slice(comma2 + 1);
  if (type === "plural") return formatPlural(name, arms, values, locale);
  if (type === "select") return formatSelect(name, arms, values, locale);
  const value = values[name];
  return value === undefined ? `{${name}}` : String(value);
}

function indexOfTopComma(source: string): number {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

function parseArms(source: string): Record<string, string> {
  const arms: Record<string, string> = {};
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i] ?? "")) i++;
    if (i >= source.length) break;
    const keyStart = i;
    while (i < source.length && source[i] !== "{") i++;
    const key = source.slice(keyStart, i).trim();
    if (source[i] !== "{") break;
    const end = matchingBrace(source, i);
    if (end < 0) break;
    arms[key] = source.slice(i + 1, end);
    i = end + 1;
  }
  return arms;
}

function formatPlural(name: string, armsSrc: string, values: FormatValues, locale: string): string {
  const raw = values[name];
  const count = typeof raw === "number" ? raw : Number(raw);
  const arms = parseArms(armsSrc);
  const rule = Number.isFinite(count) ? new Intl.PluralRules(locale).select(count) : "other";
  const exact = Number.isFinite(count) ? arms[`=${count}`] : undefined;
  const template = exact ?? arms[rule] ?? arms.other ?? "";
  const formatted = Number.isFinite(count) ? new Intl.NumberFormat(locale).format(count) : String(raw ?? "");
  return replaceTokens(template.replace(/#/g, formatted), values, locale);
}

function formatSelect(name: string, armsSrc: string, values: FormatValues, locale: string): string {
  const raw = values[name];
  const key = raw === undefined || raw === null ? "other" : String(raw);
  const arms = parseArms(armsSrc);
  return replaceTokens(arms[key] ?? arms.other ?? "", values, locale);
}

export function formatDate(locale: string, value: Date | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, options ?? { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function formatNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}
