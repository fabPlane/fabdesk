// Replay of the 32 verify_drc calls recorded in PCBGolf attempt 001
// (pcbgolf/attempts/001-baseline-characterization/project/.fabdesk/runs/*/trace.jsonl)
// through the real tool handler. Not a unit test: a measurement harness for the H9-S gate.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

type Case = {
  runId: string;
  args: Record<string, unknown>;
  recordedBytes: number;
  recordedTextBytes: number;
  isError: boolean;
  counts: { errors: number; warnings: number; unconnected: number };
  violations: any[];
  unconnected: any[];
  schematicParity: any[];
};

const cases: Case[] = await Bun.file(process.argv[2]!).json();
let oldTotal = 0;
let newTotal = 0;
let stillError = 0;
let worst = 0;
const rows: string[] = [];

for (const [i, c] of cases.entries()) {
  const project = await tempProject(`replay-${i}`);
  await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (version 20260831))\n");
  await writeFile(join(project.dir, "board.kicad_sch"), "(kicad_sch (version 20260831))\n");
  const base = mockServices([project]);
  const services = mockServices([project], {
    kicad: {
      ...base.kicad,
      runDrc: async () => ({
        violations: c.violations,
        unconnected: c.unconnected,
        schematicParity: c.schematicParity,
        counts: c.counts,
      }),
    },
  });
  const reg = createRegistry();
  const factory = contextFactory(services, project);
  // Parity is replayed as false: the recorded hierarchy is not reconstructable here, and parity
  // only adds a third category, which the same rule bounds.
  const result = await reg.invoke(
    "verify_drc",
    { ...c.args, schematicParity: false },
    (ref) =>
      factory({
        def: reg.get("verify_drc")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  const after = JSON.stringify(result.json).length + (result.text?.length ?? 0);
  if (result.isError) stillError++;
  oldTotal += c.recordedBytes;
  newTotal += after;
  worst = Math.max(worst, after);
  rows.push(
    `${c.runId.slice(0, 14)} limit=${String(c.args["limit"] ?? 30).padStart(3)} ` +
      `old=${String(c.recordedBytes).padStart(7)}B ${c.isError ? "isError" : "ok     "} -> ` +
      `new=${String(after).padStart(6)}B ${result.isError ? "isError" : "ok"} ` +
      `counts=${JSON.stringify(result.json.counts) === JSON.stringify(c.counts) ? "same" : "DIFF"}`,
  );
}

console.log(rows.join("\n"));
console.log(
  `\ncases=${cases.length} recordedIsError=${cases.filter((c) => c.isError).length} nowIsError=${stillError}`,
);
console.log(
  `total old=${(oldTotal / 1024).toFixed(0)} KiB  new=${(newTotal / 1024).toFixed(0)} KiB  reduction=${(100 - (newTotal / oldTotal) * 100).toFixed(1)}%  largest new response=${worst} B`,
);
