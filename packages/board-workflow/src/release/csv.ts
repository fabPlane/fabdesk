/** Small RFC 4180 reader/writer for the BOM, CPL and position files. */

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const quote = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : typeof v === "number" ? String(v) : Array.isArray(v) ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(fields: readonly string[], rows: ReadonlyArray<Record<string, unknown> | readonly unknown[]>): string {
  const lines = [fields.map(quote).join(",")];
  for (const r of rows) lines.push((Array.isArray(r) ? (r as unknown[]) : fields.map((f) => (r as Record<string, unknown>)[f])).map(quote).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Python 3.12+ `sum()` of floats (Neumaier compensated), so means and RMS values agree with the oracle to the last bit. */
export function pySum(a: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const x of a) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}
