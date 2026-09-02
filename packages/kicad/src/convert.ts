import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CircuitJsonToKicadPcbConverter, CircuitJsonToKicadProConverter, CircuitJsonToKicadSchConverter } from "circuit-json-to-kicad";
import type { AnyCircuitElement } from "circuit-json";

export interface ConvertOptions {
  circuitJson: unknown[];
  projectDir: string;
  projectName: string;
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
    await Bun.write(join(opts.projectDir, proFile), pro.getOutputString());
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
