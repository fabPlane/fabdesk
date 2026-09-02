import { spiceNetlist } from "./netlist";
import { findNgspice, runNgspice } from "./ngspice";
import { runSpicey } from "./spicey";
import type { RunSimulationOptions, SimResult } from "./types";

/** Netlists the circuit and runs the analysis with spicey (default) or ngspice. */
export async function runSimulation(opts: RunSimulationOptions): Promise<SimResult> {
  opts.signal?.throwIfAborted();
  const netlist = spiceNetlist(opts.circuitJson);
  const engine = opts.engine ?? "spicey";
  if (engine === "spicey") return runSpicey(netlist, opts.analysis);
  const ngspice = await findNgspice(opts.ngspicePath);
  if (!ngspice) throw new Error("ngspice not found; install it (brew install ngspice) or pass ngspicePath");
  return runNgspice(ngspice, netlist, opts.analysis, opts.signal);
}
