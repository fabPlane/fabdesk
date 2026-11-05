import type { NetlistComponent } from "@fabdesk/protocol";
import { ToolError } from "./registry";

/** Bounded CSV from native KiCad, including quoted commas, quotes and line breaks. */
function csvRows(csv: string): string[][] {
  if (csv.length > 10 * 1024 * 1024) throw new ToolError("Native BOM exceeds 10 MB", "precondition");
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ""; closed = false; if (row.length > 32) throw new ToolError("Native BOM has too many columns", "precondition"); };
  const finishRow = () => { finishCell(); if (row.some(value => value.length)) rows.push(row); row = []; if (rows.length > 50_001) throw new ToolError("Native BOM exceeds 50,000 rows", "precondition"); };
  const text = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; finishRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || char === '"') throw new ToolError("Native BOM has malformed CSV quoting", "precondition");
    else cell += char;
  }
  if (quoted) throw new ToolError("Native BOM has an unterminated quoted field", "precondition");
  if (cell || row.length || closed) finishRow();
  return rows;
}

/** Never infer BOM membership or expand a quantity without the native references that justify it. */
export function nativeBomComponents(csv: string): NetlistComponent[] {
  const [header, ...rows] = csvRows(csv);
  if (!header) throw new ToolError("Native BOM has no field header", "precondition");
  const keys = header.map(field => field.trim().toLowerCase());
  const required = ["reference", "value", "footprint", "quantity", "dnp", "exclude_from_bom", "exclude_from_board"];
  if (new Set(keys).size !== keys.length || required.some(key => !keys.includes(key))) throw new ToolError("Native BOM is missing its explicit source/exclusion fields", "precondition");
  const components: NetlistComponent[] = [], seen = new Set<string>();
  for (const row of rows) {
    if (row.length !== keys.length) throw new ToolError("Native BOM row does not match its fields", "precondition");
    const get = (key: string) => row[keys.indexOf(key)]?.trim() ?? "";
    const excluded = (key: string) => {
      const value = get(key);
      if (/^(?:1|true|yes|x|dnp|excluded)$/i.test(value)) return true;
      if (/^(?:0|false|no)?$/i.test(value)) return false;
      throw new ToolError(`Native BOM has an unrecognized ${key} flag`, "precondition");
    };
    if (excluded("dnp") || excluded("exclude_from_bom") || excluded("exclude_from_board")) continue;
    const refs = get("reference").split(",").map(ref => ref.trim()), quantity = Number(get("quantity"));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity !== refs.length || refs.some(ref => !ref || ref.length > 80)) throw new ToolError("Native BOM quantity cannot be reconciled with its explicit references", "precondition");
    for (const ref of refs) {
      if (ref.startsWith("#")) continue;
      if (seen.has(ref)) throw new ToolError(`Native BOM repeats reference ${ref}; resolve annotation before using its quantities`, "precondition");
      seen.add(ref);
      const fields = Object.fromEntries(keys.flatMap((key, index) => ["reference", "value", "footprint", "quantity", "dnp", "exclude_from_bom", "exclude_from_board"].includes(key) || !row[index]?.trim() ? [] : [[header[index]!, row[index]!.trim()]]));
      components.push({ ref, value: get("value"), footprint: get("footprint"), ...(Object.keys(fields).length ? { fields } : {}) });
    }
  }
  return components;
}
