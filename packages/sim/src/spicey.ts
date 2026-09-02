import { parseNetlist, simulate } from "spicey";
import { analysisLine, ensureAcStimulus, netlistBody } from "./netlist";
import type { SimAnalysis, SimResult } from "./types";

type Parsed = ReturnType<typeof parseNetlist>;

/**
 * Runs an analysis with the pure-JS spicey engine. spicey only knows `.ac` and `.tran`, so `.op`
 * is solved here: a linear DC MNA (capacitors open, inductors shorted) when the circuit has only
 * R/C/L/V elements, otherwise a short settling transient whose final sample is reported.
 */
export function runSpicey(netlist: string, analysis: SimAnalysis): SimResult {
  const body = netlistBody(netlist);
  const log: string[] = [];
  switch (analysis.kind) {
    case "op":
      return { engine: "spicey", analysis: "op", ...operatingPoint(body, log), log: log.join("\n") };
    case "tran": {
      const text = `${body}\n${analysisLine(analysis)}\n.end\n`;
      const parsed = parseNetlist(text);
      noteSkipped(parsed, log);
      const result = simulate(text).tran;
      if (!result) throw new Error("spicey produced no transient result");
      const nodes = Object.keys(result.nodeVoltages);
      const currents = Object.keys(result.elementCurrents);
      const columns = ["time", ...nodes.map((n) => `v(${n.toLowerCase()})`), ...currents.map((c) => `i(${c.toLowerCase()})`)];
      const rows = result.times.map((t, i) => [
        t,
        ...nodes.map((n) => result.nodeVoltages[n]?.[i] ?? Number.NaN),
        ...currents.map((c) => result.elementCurrents[c]?.[i] ?? Number.NaN),
      ]);
      return { engine: "spicey", analysis: "tran", columns, rows, log: log.join("\n") };
    }
    case "ac": {
      const text = `${ensureAcStimulus(body)}\n${analysisLine(analysis)}\n.end\n`;
      const parsed = parseNetlist(text);
      noteSkipped(parsed, log);
      const result = simulate(text).ac;
      if (!result) throw new Error("spicey produced no AC result");
      const nodes = Object.keys(result.nodeVoltages);
      const columns = ["frequency", ...nodes.flatMap((n) => [`v(${n.toLowerCase()}).mag`, `v(${n.toLowerCase()}).phase_deg`])];
      const rows = result.freqs.map((f, i) => [
        f,
        ...nodes.flatMap((n) => {
          const c = result.nodeVoltages[n]?.[i];
          return c ? [c.abs(), c.phaseDeg()] : [Number.NaN, Number.NaN];
        }),
      ]);
      return { engine: "spicey", analysis: "ac", columns, rows, log: log.join("\n") };
    }
  }
}

function noteSkipped(parsed: Parsed, log: string[]): void {
  if (parsed.skipped.length) log.push(`spicey skipped ${parsed.skipped.length} line(s): ${parsed.skipped.join(" | ")}`);
}

function operatingPoint(body: string, log: string[]): Pick<SimResult, "columns" | "rows"> {
  const parsed = parseNetlist(`${body}\n.end\n`);
  noteSkipped(parsed, log);
  if (parsed.D.length === 0 && parsed.S.length === 0) {
    log.push("spicey op: linear DC MNA (C open, L short)");
    return linearDcOp(parsed);
  }
  // Nonlinear elements: let spicey's transient settle and report the final sample.
  const step = 1e-6;
  const stop = 2e-3;
  log.push(`spicey op: nonlinear elements present, using final sample of .tran ${step} ${stop}`);
  const result = simulate(`${body}\n.tran ${step} ${stop}\n.end\n`).tran;
  if (!result) throw new Error("spicey produced no transient result for op fallback");
  const last = result.times.length - 1;
  const nodes = Object.keys(result.nodeVoltages);
  const currents = Object.keys(result.elementCurrents);
  return {
    columns: [...nodes.map((n) => `v(${n.toLowerCase()})`), ...currents.map((c) => `i(${c.toLowerCase()})`)],
    rows: [[...nodes.map((n) => result.nodeVoltages[n]?.[last] ?? Number.NaN), ...currents.map((c) => result.elementCurrents[c]?.[last] ?? Number.NaN)]],
  };
}

/** Modified nodal analysis for R + V (+ L as 0 V sources); ground is node "0". */
function linearDcOp(ckt: Parsed): Pick<SimResult, "columns" | "rows"> {
  const ground = ckt.nodes.get("0");
  if (ground === undefined) throw new Error("netlist has no ground node (0)");
  const nodeNames = ckt.nodes.rev.filter((_, id) => id !== ground);
  const nodeIndex = new Map<number, number>();
  nodeNames.forEach((name) => {
    const id = ckt.nodes.get(name);
    if (id !== undefined) nodeIndex.set(id, nodeIndex.size);
  });
  const n = nodeNames.length;
  const branches: Array<{ name: string; n1: number; n2: number; value: number }> = [
    ...ckt.V.map((v) => ({ name: v.name, n1: v.n1, n2: v.n2, value: v.dc })),
    ...ckt.L.map((l) => ({ name: l.name, n1: l.n1, n2: l.n2, value: 0 })),
  ];
  const size = n + branches.length;
  const A: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const b = new Array<number>(size).fill(0);
  const idx = (node: number): number | null => (node === ground ? null : (nodeIndex.get(node) ?? null));
  for (const r of ckt.R) {
    const g = 1 / r.R;
    const i = idx(r.n1);
    const j = idx(r.n2);
    if (i !== null) A[i]![i]! += g;
    if (j !== null) A[j]![j]! += g;
    if (i !== null && j !== null) {
      A[i]![j]! -= g;
      A[j]![i]! -= g;
    }
  }
  branches.forEach((br, k) => {
    const row = n + k;
    const i = idx(br.n1);
    const j = idx(br.n2);
    if (i !== null) {
      A[i]![row]! += 1;
      A[row]![i]! += 1;
    }
    if (j !== null) {
      A[j]![row]! -= 1;
      A[row]![j]! -= 1;
    }
    b[row] = br.value;
  });
  const x = solve(A, b);
  const columns = [...nodeNames.map((name) => `v(${name.toLowerCase()})`), ...branches.map((br) => `i(${br.name.toLowerCase()})`)];
  return { columns, rows: [x.map((v) => (Object.is(v, -0) ? 0 : v))] };
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    if (Math.abs(M[pivot]![col]!) < 1e-15) throw new Error("singular matrix: floating node or voltage-source loop in the circuit");
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}
