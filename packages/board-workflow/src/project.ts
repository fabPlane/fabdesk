/** The `.kicad_pro` settings the workflow reads: net classes, assignments, board rules. */

export interface NetClass {
  name: string;
  track_width?: number;
  clearance?: number;
  via_diameter?: number;
  via_drill?: number;
  diff_pair_width?: number;
  diff_pair_gap?: number;
}

export interface ProjectSettings {
  classes: NetClass[];
  /** KiCad wildcard pattern -> class. */
  patterns: Array<{ pattern: string; netclass: string }>;
  /** Net name -> class (explicit assignments). */
  assignments: Record<string, string>;
  minTrackWidth: number | null;
  minClearance: number | null;
}

type Json = Record<string, unknown>;

export function readProjectSettings(text: string): ProjectSettings {
  const pro = JSON.parse(text) as Json;
  const ns = (pro["net_settings"] ?? {}) as Json;
  const rules = ((((pro["board"] ?? {}) as Json)["design_settings"] ?? {}) as Json)["rules"] as Json | undefined;
  const assignments: Record<string, string> = {};
  for (const [n, c] of Object.entries((ns["netclass_assignments"] ?? {}) as Json))
    assignments[n] = Array.isArray(c) ? String(c[0]) : String(c);
  const orNull = (v: unknown) => (typeof v === "number" && v ? v : null);
  return {
    classes: ((ns["classes"] ?? []) as NetClass[]).filter((c) => c && typeof c.name === "string"),
    patterns: ((ns["netclass_patterns"] ?? []) as Array<{ pattern: string; netclass: string }>).filter(
      (p) => p && typeof p.pattern === "string",
    ),
    assignments,
    minTrackWidth: orNull(rules?.["min_track_width"]),
    minClearance: orNull(rules?.["min_clearance"]),
  };
}

/** Board nets -> class name: patterns first (KiCad wildcards), then explicit assignments. */
export function netsByClass(settings: ProjectSettings, nets: Iterable<string>): Map<string, string> {
  const list = [...nets];
  const out = new Map<string, string>();
  for (const p of settings.patterns) {
    const rx = new RegExp(
      "^" +
        [...p.pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&"))).join("") +
        "$",
      "s",
    );
    for (const n of list) if (rx.test(n)) out.set(n, p.netclass);
  }
  const have = new Set(list);
  for (const [n, c] of Object.entries(settings.assignments)) if (have.has(n)) out.set(n, c);
  return out;
}
