import { circuitJsonToSpice, convertSpiceNetlistToString } from "circuit-json-to-spice";
import type { AnyCircuitElement } from "circuit-json";
import type { SimAnalysis } from "./types";

/** SPICE netlist (with `.END`) for the circuit via circuit-json-to-spice. */
export function spiceNetlist(circuitJson: unknown[]): string {
  return convertSpiceNetlistToString(circuitJsonToSpice(circuitJson as AnyCircuitElement[]));
}

/** Netlist body without the trailing `.END` so analysis/control lines can be appended. */
export function netlistBody(netlist: string): string {
  return netlist
    .split("\n")
    .filter((line) => !/^\s*\.end\s*$/i.test(line))
    .join("\n")
    .trimEnd();
}

/** Dot-command for an analysis (shared by spicey and ngspice). */
export function analysisLine(analysis: SimAnalysis): string {
  switch (analysis.kind) {
    case "op":
      return ".op";
    case "tran":
      return `.tran ${fmt(analysis.stepS)} ${fmt(analysis.stopS)}`;
    case "ac":
      return `.ac dec ${analysis.pointsPerDecade} ${fmt(analysis.startHz)} ${fmt(analysis.stopHz)}`;
  }
}

/**
 * AC analysis needs a small-signal stimulus. circuit-json-to-spice emits DC-only sources, so when
 * no independent voltage source carries an `AC` term, the first one gets `AC 1`.
 */
export function ensureAcStimulus(body: string): string {
  const lines = body.split("\n");
  const hasAc = lines.some((l) => /^v\S*\s/i.test(l) && /\bac\b/i.test(l));
  if (hasAc) return body;
  const index = lines.findIndex((l) => /^v\S*\s/i.test(l));
  if (index === -1) return body;
  lines[index] = `${lines[index]} AC 1`;
  return lines.join("\n");
}

export function fmt(value: number): string {
  return Number.isFinite(value) ? value.toExponential(6).replace(/\.?0+e/, "e") : String(value);
}
