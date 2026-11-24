import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ensureAcStimulus, findNgspice, parseAsciiRaw, runSimulation, spiceNetlist, type SimResult } from "../src/index";
import { runNgspice } from "../src/ngspice";

import type { NetlistFile } from "@fabdesk/protocol";
const netlist = (await Bun.file(join(import.meta.dir, "fixtures/divider.netlist.json")).json()) as NetlistFile;
// V1 = 5 V, R1 = 1k, R2 = 3k (+ C1 = 1uF across R2): v(n2) = 5 * 3/(1+3) = 3.75 V, i(V1) = -1.25 mA.
const col = (r: SimResult, name: string) => {
  const i = r.columns.indexOf(name);
  if (i === -1) throw new Error(`missing column ${name} in ${r.columns.join(",")}`);
  return i;
};
const last = (r: SimResult) => r.rows[r.rows.length - 1]!;
const ngspicePath = await findNgspice();

test("ngspice detection and batch simulation request hidden consoles", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("ngspice unavailable"); });
  try {
    expect(await findNgspice(process.execPath)).toBeNull();
    await expect(runNgspice(process.execPath, spiceNetlist(netlist), { kind: "op" })).rejects.toThrow("ngspice unavailable");
    const hidden = expect.objectContaining({ windowsHide: true });
    expect(spawn).toHaveBeenCalledWith([process.execPath, "-v"], hidden);
    expect(spawn).toHaveBeenCalledWith([process.execPath, "-b", expect.any(String)], hidden);
  } finally {
    spawn.mockRestore();
  }
});

describe("spiceNetlist", () => {
  test("netlists the divider", () => {
    const text = spiceNetlist(netlist);
    expect(text).toMatch(/^RR1 N1 N2 1K$/m);
    expect(text).toMatch(/^RR2 N2 0 3K$/m);
    expect(text).toMatch(/^CC1 N2 0 1U$/m);
    expect(text).toMatch(/^V\S+ N1 0 DC 5$/m);
    expect(text.trim()).toMatch(/\.END$/i);
    expect(ensureAcStimulus("RR1 N1 N2 1K\nV1 N1 0 DC 5")).toBe("RR1 N1 N2 1K\nV1 N1 0 DC 5 AC 1");
    expect(ensureAcStimulus("V1 N1 0 DC 5 AC 2")).toBe("V1 N1 0 DC 5 AC 2");
  });
});

describe("spicey", () => {
  test("op matches the hand calculation", async () => {
    const r = await runSimulation({ netlist, analysis: { kind: "op" } });
    expect(r.engine).toBe("spicey");
    expect(r.rows.length).toBe(1);
    expect(last(r)[col(r, "v(n1)")]).toBeCloseTo(5, 9);
    expect(last(r)[col(r, "v(n2)")]).toBeCloseTo(3.75, 9);
    const iSource = r.columns.find((c) => c.startsWith("i(v"))!;
    expect(last(r)[col(r, iSource)]).toBeCloseTo(-1.25e-3, 9);
  });

  test("tran settles to the divider voltage (RC tau = 0.75 ms)", async () => {
    const r = await runSimulation({ netlist, analysis: { kind: "tran", stepS: 1e-6, stopS: 10e-3 } });
    expect(r.columns[0]).toBe("time");
    expect(r.rows.length).toBeGreaterThan(100);
    expect(last(r)[col(r, "v(n2)")]).toBeCloseTo(3.75, 3);
  });

  test("ac sweeps decades and shows the RC roll-off", async () => {
    const r = await runSimulation({ netlist, analysis: { kind: "ac", startHz: 1, stopHz: 1e6, pointsPerDecade: 5 } });
    expect(r.columns[0]).toBe("frequency");
    expect(r.rows.length).toBe(31);
    const mag = col(r, "v(n2).mag");
    expect(r.rows[0]![mag]).toBeCloseTo(0.75, 3);
    expect(last(r)[mag]).toBeLessThan(0.01);
  });
});

describe("ngspice", () => {
  test("parses an ASCII rawfile", () => {
    const raw = "Title: t\nPlotname: Operating Point\nFlags: real\nNo. Variables: 2\nNo. Points: 1\nVariables:\n\t0\tv(n1)\tvoltage\n\t1\tv(n2)\tvoltage\nValues:\n 0\t5.0e+00\n\t3.75e+00\n\n";
    const parsed = parseAsciiRaw(raw);
    expect(parsed.variables).toEqual(["v(n1)", "v(n2)"]);
    expect(parsed.rows).toEqual([[5, 3.75]]);
  });

  test.skipIf(!ngspicePath)("op/tran/ac agree with spicey", async () => {
    const op = await runSimulation({ netlist, analysis: { kind: "op" }, engine: "ngspice" });
    expect(op.engine).toBe("ngspice");
    expect(op.log).toContain("ngspice");
    expect(last(op)[col(op, "v(n2)")]).toBeCloseTo(3.75, 6);
    const spicey = await runSimulation({ netlist, analysis: { kind: "op" } });
    expect(last(op)[col(op, "v(n1)")]).toBeCloseTo(last(spicey)[col(spicey, "v(n1)")]!, 6);

    const tran = await runSimulation({ netlist, analysis: { kind: "tran", stepS: 1e-5, stopS: 5e-3 }, engine: "ngspice" });
    expect(tran.columns[0]).toBe("time");
    expect(last(tran)[col(tran, "v(n2)")]).toBeCloseTo(3.75, 2);

    const ac = await runSimulation({ netlist, analysis: { kind: "ac", startHz: 1, stopHz: 1e6, pointsPerDecade: 5 }, engine: "ngspice" });
    const acSpicey = await runSimulation({ netlist, analysis: { kind: "ac", startHz: 1, stopHz: 1e6, pointsPerDecade: 5 } });
    expect(ac.rows.length).toBe(acSpicey.rows.length);
    expect(ac.rows[0]![col(ac, "v(n2).mag")]).toBeCloseTo(acSpicey.rows[0]![col(acSpicey, "v(n2).mag")]!, 3);
  }, 60_000);
});
