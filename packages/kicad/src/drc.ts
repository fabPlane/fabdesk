import { runKicadCli, type KicadCli } from "./cli";

export type Severity = "error" | "warning" | "exclusion";

export interface DrcAffectedGeometry {
  objectType: string;
  [key: string]: unknown;
}

export interface DrcItem {
  description: string;
  uuid?: string;
  pos?: { x: number; y: number };
  net?: string;
  layer?: string | number;
  layers?: Array<string | number>;
}

export interface DrcViolation {
  rule: string;
  severity: Severity;
  description: string;
  items: DrcItem[];
  coordinates: Array<{ x: number; y: number }>;
  layers: Array<string | number>;
  nets: string[];
  objectIds: string[];
  affectedGeometry: DrcAffectedGeometry[];
  /** `${rule}:${first item description}`; stable across runs, used for warning baselines. */
  signature: string;
}

export interface DrcReport {
  violations: DrcViolation[];
  unconnected: DrcViolation[];
  schematicParity: DrcViolation[];
  counts: { errors: number; warnings: number; unconnected: number };
  raw: unknown;
}

export interface ErcReport {
  violations: DrcViolation[];
  counts: { errors: number; warnings: number };
  raw: unknown;
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
  newWarningSignatures: string[];
}

interface RawItem {
  description?: string;
  uuid?: string;
  pos?: { x: number; y: number };
  net?: string;
  layer?: string | number;
  layers?: Array<string | number>;
}
interface RawViolation {
  type?: string;
  severity?: string;
  description?: string;
  items?: RawItem[];
}
interface RawDrc {
  violations?: RawViolation[];
  unconnected_items?: RawViolation[];
  schematic_parity?: RawViolation[];
}
interface RawErc {
  sheets?: Array<{ path?: string; violations?: RawViolation[] }>;
}

function toSeverity(value: unknown): Severity {
  return value === "error" || value === "warning" || value === "exclusion" ? value : "error";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function normalizeViolation(raw: RawViolation): DrcViolation {
  const rule = raw.type ?? "unknown";
  const items = (raw.items ?? []).map((item) => ({
    description: item.description ?? "",
    ...(item.uuid ? { uuid: item.uuid } : {}),
    ...(item.pos ? { pos: { x: item.pos.x, y: item.pos.y } } : {}),
    ...(item.net ? { net: item.net } : {}),
    ...(item.layer !== undefined ? { layer: item.layer } : {}),
    ...(item.layers ? { layers: item.layers } : {}),
  }));
  return {
    rule,
    severity: toSeverity(raw.severity),
    description: raw.description ?? "",
    items,
    coordinates: items.flatMap((item) => (item.pos ? [item.pos] : [])),
    layers: unique(
      items
        .flatMap((item) => [item.layer, ...(item.layers ?? [])])
        .filter((layer): layer is string | number => layer !== undefined),
    ),
    nets: unique(items.flatMap((item) => (item.net ? [item.net] : []))),
    objectIds: unique(items.flatMap((item) => (item.uuid ? [item.uuid] : []))),
    affectedGeometry: [],
    signature: `${rule}:${items[0]?.description ?? "NO_REFERENCE"}`,
  };
}

const count = (list: DrcViolation[], severity: Severity) =>
  list.filter((v) => v.severity === severity).length;

function severityArg(severity: "error" | "all" | "project" | undefined): string[] {
  // "project": no flag, so the project's own rule severities (ignored rules stay ignored) decide what is reported
  return severity === "project" ? [] : [severity === "error" ? "--severity-error" : "--severity-all"];
}

/** `kicad-cli pcb drc --format json` into `outFile`, parsed into a DrcReport. */
export async function runDrc(
  cli: KicadCli,
  opts: {
    board: string;
    outFile: string;
    severity?: "error" | "all" | "project";
    schematicParity?: boolean;
    refillZones?: boolean;
    signal?: AbortSignal;
  },
): Promise<DrcReport> {
  const args = ["pcb", "drc", "--format", "json", "--units", "mm", ...severityArg(opts.severity)];
  if (opts.schematicParity) args.push("--schematic-parity");
  if (opts.refillZones) args.push("--refill-zones");
  args.push("-o", opts.outFile, opts.board);
  await runKicadCli(cli, args, { ...(opts.signal ? { signal: opts.signal } : {}) });
  const file = Bun.file(opts.outFile);
  if (!(await file.exists())) throw new Error(`kicad-cli pcb drc did not write ${opts.outFile}`);
  return parseDrcJson((await file.json()) as RawDrc);
}

export function parseDrcJson(raw: RawDrc): DrcReport {
  const violations = (raw.violations ?? []).map(normalizeViolation);
  const unconnected = (raw.unconnected_items ?? []).map(normalizeViolation);
  const schematicParity = (raw.schematic_parity ?? []).map(normalizeViolation);
  return {
    violations,
    unconnected,
    schematicParity,
    counts: {
      errors: count(violations, "error") + count(schematicParity, "error"),
      warnings: count(violations, "warning") + count(schematicParity, "warning"),
      unconnected: unconnected.length,
    },
    raw,
  };
}

/** `kicad-cli sch erc --format json` into `outFile`, parsed (all sheets flattened). */
export async function runErc(
  cli: KicadCli,
  opts: { schematic: string; outFile: string; severity?: "error" | "all"; signal?: AbortSignal },
): Promise<ErcReport> {
  const args = [
    "sch",
    "erc",
    "--format",
    "json",
    "--units",
    "mm",
    ...severityArg(opts.severity),
    "-o",
    opts.outFile,
    opts.schematic,
  ];
  await runKicadCli(cli, args, { ...(opts.signal ? { signal: opts.signal } : {}) });
  const file = Bun.file(opts.outFile);
  if (!(await file.exists())) throw new Error(`kicad-cli sch erc did not write ${opts.outFile}`);
  return parseErcJson((await file.json()) as RawErc);
}

export function parseErcJson(raw: RawErc): ErcReport {
  const violations = (raw.sheets ?? []).flatMap((sheet) =>
    (sheet.violations ?? []).map(normalizeViolation),
  );
  return {
    violations,
    counts: { errors: count(violations, "error"), warnings: count(violations, "warning") },
    raw,
  };
}

/**
 * Release gate (semantics from kicad-automation's `gate`): zero DRC errors, zero unconnected items,
 * zero ERC errors when a schematic report is given, and every DRC warning signature present in the
 * allowed baseline.
 */
export function gate(
  drc: DrcReport,
  erc: ErcReport | undefined,
  allowedWarningSignatures: string[],
): GateResult {
  const reasons: string[] = [];
  if (drc.counts.errors > 0) reasons.push(`${drc.counts.errors} DRC error(s)`);
  if (drc.counts.unconnected > 0) reasons.push(`${drc.counts.unconnected} unconnected item(s)`);
  if (erc && erc.counts.errors > 0) reasons.push(`${erc.counts.errors} ERC error(s)`);
  const allowed = new Set(allowedWarningSignatures);
  const observed = [...drc.violations, ...drc.schematicParity]
    .filter((v) => v.severity === "warning")
    .map((v) => v.signature);
  const newWarningSignatures = [...new Set(observed.filter((sig) => !allowed.has(sig)))];
  if (newWarningSignatures.length > 0) {
    reasons.push(`${newWarningSignatures.length} DRC warning(s) not in the allowed baseline`);
  }
  return { pass: reasons.length === 0, reasons, newWarningSignatures };
}
