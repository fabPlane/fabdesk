import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CircuitJsonToKicadPcbConverter, CircuitJsonToKicadProConverter, CircuitJsonToKicadSchConverter } from "circuit-json-to-kicad";
import type { AnyCircuitElement } from "circuit-json";

export interface ConvertOptions {
  circuitJson: unknown[];
  projectDir: string;
  projectName: string;
  /**
   * Board rules (fabdesk.json `board.rules`, e.g. a Viagrid blank's 0.2 mm track / clearance). Written into
   * the generated `.kicad_pro` so KiCad DRC checks the board against them instead of the converter's 0.1 mm
   * defaults.
   */
  rules?: { traceWidthMm?: number; clearanceMm?: number; viaDrillMm?: number; viaDiameterMm?: number };
}

/**
 * DRC rules that can only fire on a generated board: every footprint is embedded and belongs to a
 * `tscircuit` library that no library table knows, so KiCad emits one `lib_footprint_issues` warning per
 * footprint (192 on a Viagrid board). They carry no information here and bury real findings.
 */
export const GENERATED_BOARD_RULE_SEVERITIES: Record<string, "ignore"> = {
  lib_footprint_issues: "ignore",
  lib_footprint_mismatch: "ignore",
};

/** Silences the library-table warnings in a `.kicad_pro` JSON document. */
export function silenceLibraryWarnings(proJson: string): string {
  const pro = JSON.parse(proJson) as Record<string, unknown>;
  const board = ((pro["board"] ??= {}) as Record<string, unknown>);
  const design = ((board["design_settings"] ??= {}) as Record<string, unknown>);
  const severities = ((design["rule_severities"] ??= {}) as Record<string, unknown>);
  for (const [rule, severity] of Object.entries(GENERATED_BOARD_RULE_SEVERITIES)) severities[rule] ??= severity;
  return JSON.stringify(pro, null, 2);
}

/** Applies `rules` to a `.kicad_pro` JSON document (design rules + the Default netclass). */
export function applyRulesToKicadPro(proJson: string, rules: NonNullable<ConvertOptions["rules"]>): string {
  const pro = JSON.parse(proJson) as Record<string, unknown>;
  const board = ((pro["board"] ??= {}) as Record<string, unknown>);
  const design = ((board["design_settings"] ??= {}) as Record<string, unknown>);
  const drc = ((design["rules"] ??= {}) as Record<string, unknown>);
  if (rules.clearanceMm !== undefined) drc["min_clearance"] = rules.clearanceMm;
  if (rules.traceWidthMm !== undefined) drc["min_track_width"] = rules.traceWidthMm;
  if (rules.viaDiameterMm !== undefined) drc["min_via_diameter"] = rules.viaDiameterMm;
  if (rules.viaDrillMm !== undefined) drc["min_through_hole_diameter"] = rules.viaDrillMm;
  const net = ((pro["net_settings"] ??= {}) as Record<string, unknown>);
  const classes = Array.isArray(net["classes"]) ? (net["classes"] as Array<Record<string, unknown>>) : [];
  for (const cls of classes) {
    if (rules.clearanceMm !== undefined) cls["clearance"] = rules.clearanceMm;
    if (rules.traceWidthMm !== undefined) cls["track_width"] = rules.traceWidthMm;
    if (rules.viaDiameterMm !== undefined) cls["via_diameter"] = rules.viaDiameterMm;
    if (rules.viaDrillMm !== undefined) cls["via_drill"] = rules.viaDrillMm;
  }
  return JSON.stringify(pro, null, 2);
}

/**
 * Writes `<projectName>.kicad_pcb`, `.kicad_sch` (+ one child sheet per schematic_sheet) and
 * `.kicad_pro` into projectDir. KiCad 10 opens the output directly (format version 20241229),
 * so no `pcb upgrade` pass is needed. Warnings collect the errors the converters logged.
 */
export async function convertToKicad(opts: ConvertOptions): Promise<{ files: string[]; warnings: string[] }> {
  const circuitJson = opts.circuitJson as AnyCircuitElement[];
  const name = opts.projectName;
  if (!/^[\w.-]+$/.test(name)) throw new Error(`projectName must be a plain file stem, got ${JSON.stringify(name)}`);
  await mkdir(opts.projectDir, { recursive: true });
  const warnings: string[] = [];
  const restore = captureConsoleWarnings(warnings);
  const files: string[] = [];
  try {
    const pcb = new CircuitJsonToKicadPcbConverter(circuitJson, { projectName: name });
    pcb.runUntilFinished();
    const pcbFile = `${name}.kicad_pcb`;
    await Bun.write(join(opts.projectDir, pcbFile), pcb.getOutputString());
    files.push(pcbFile);

    const sch = new CircuitJsonToKicadSchConverter(circuitJson);
    sch.runUntilFinished();
    const schFile = `${name}.kicad_sch`;
    for (const sheet of sch.getOutputFiles({ schematicFilename: schFile })) {
      await Bun.write(join(opts.projectDir, sheet.filename), sheet.content);
      files.push(sheet.filename);
    }

    const pro = new CircuitJsonToKicadProConverter(circuitJson, {
      projectName: name,
      schematicFilename: schFile,
      pcbFilename: pcbFile,
      schematicSheetPlan: sch.schematicSheetPlan,
    });
    pro.runUntilFinished();
    const proFile = `${name}.kicad_pro`;
    const withSeverities = silenceLibraryWarnings(pro.getOutputString());
    const proText = opts.rules && Object.keys(opts.rules).length > 0 ? applyRulesToKicadPro(withSeverities, opts.rules) : withSeverities;
    await Bun.write(join(opts.projectDir, proFile), proText);
    files.push(proFile);
  } finally {
    restore();
  }
  return { files, warnings };
}

function captureConsoleWarnings(sink: string[]): () => void {
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]) => {
    sink.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.warn = capture;
  console.error = capture;
  return () => {
    console.warn = originalWarn;
    console.error = originalError;
  };
}
