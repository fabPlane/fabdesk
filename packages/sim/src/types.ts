import type { NetlistFile } from "@fabdesk/protocol";

export type SimAnalysis =
  | { kind: "op" }
  | { kind: "tran"; stepS: number; stopS: number }
  | { kind: "ac"; startHz: number; stopHz: number; pointsPerDecade: number };

export type SimEngine = "spicey" | "ngspice";

export interface SimResult {
  engine: SimEngine;
  analysis: SimAnalysis["kind"];
  /** Lower-case SPICE vector names: `time`/`frequency`, `v(n1)`, `i(v1)`; AC uses `.mag`/`.phase_deg` pairs. */
  columns: string[];
  rows: number[][];
  log: string;
}

export interface RunSimulationOptions {
  netlist: NetlistFile;
  analysis: SimAnalysis;
  engine?: SimEngine;
  ngspicePath?: string;
  signal?: AbortSignal;
}
