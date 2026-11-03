export interface ViolationItem {
  description: string;
  pos?: { x: number; y: number };
}

export interface Violation {
  source: "drc" | "erc";
  type: string;
  severity: string;
  description: string;
  items: ViolationItem[];
  excluded?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function normalizeItem(v: unknown): ViolationItem {
  const r = asRecord(v);
  if (!r) return { description: String(v) };
  const pos = asRecord(r["pos"]);
  const x = pos?.["x"];
  const y = pos?.["y"];
  return {
    description: typeof r["description"] === "string" ? r["description"] : JSON.stringify(v),
    ...(typeof x === "number" && typeof y === "number" ? { pos: { x, y } } : {}),
  };
}

function normalizeViolation(v: unknown, source: "drc" | "erc"): Violation | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    source,
    type: typeof r["rule"] === "string" ? r["rule"] : typeof r["type"] === "string" ? r["type"] : "unknown",
    severity: typeof r["severity"] === "string" ? r["severity"] : "error",
    description: typeof r["description"] === "string" ? r["description"] : JSON.stringify(v),
    items: Array.isArray(r["items"]) ? r["items"].map(normalizeItem) : [],
    ...(r["excluded"] === true ? { excluded: true } : {}),
  };
}

/** Flattens KiCad `kicad-cli pcb drc --format json` / `sch erc --format json` reports (and plain arrays). */
export function normalizeReport(json: unknown, source: "drc" | "erc"): Violation[] {
  if (!json) return [];
  if (Array.isArray(json)) return json.map((v) => normalizeViolation(v, source)).filter((v): v is Violation => !!v);
  const r = asRecord(json);
  if (!r) return [];
  const out: Violation[] = [];
  // Saved tool reports use normalized camelCase keys; raw KiCad reports use snake_case.
  // Prefer the normalized category if both are present, so raw payloads are not counted twice.
  for (const [keys, unconnected] of [
    [["violations"], false],
    [["unconnected", "unconnected_items"], true],
    [["schematicParity", "schematic_parity"], false],
  ] as const) {
    const arr = keys.map(key => r[key]).find(Array.isArray);
    if (Array.isArray(arr)) for (const v of arr) {
      const n = normalizeViolation(v, source);
      if (n) out.push(unconnected ? { ...n, type: n.type === "unknown" ? "unconnected" : n.type } : n);
    }
  }
  const sheets = r["sheets"];
  if (Array.isArray(sheets)) for (const sheet of sheets) out.push(...normalizeReport(sheet, source));
  return out;
}


/** Show errors first without changing original report indexes or saved finding identities. */
export function filterCheckFindings(findings: readonly Violation[], filter: { query?: string; severity?: string; source?: "all" | "drc" | "erc" } = {}): Array<{ finding: Violation; index: number }> {
  const terms = (filter.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return findings.map((finding, index) => ({ finding, index })).filter(({ finding }) => {
    if (filter.source && filter.source !== "all" && finding.source !== filter.source) return false;
    if (filter.severity && filter.severity !== "all" && finding.severity.toLowerCase() !== filter.severity.toLowerCase()) return false;
    const text = [finding.source, finding.type, finding.severity, finding.description, ...finding.items.map(item => item.description)].join(" ").toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => {
    const rank = (severity: string) => severity.toLowerCase() === "error" ? 0 : severity.toLowerCase() === "warning" ? 1 : 2;
    return rank(a.finding.severity) - rank(b.finding.severity) || a.index - b.index;
  });
}
