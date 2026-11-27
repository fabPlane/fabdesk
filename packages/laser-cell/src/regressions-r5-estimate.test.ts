/** Regression tests from the fifth review (2026-11-27): time estimate never blocks the core. Each failed before its fix. */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaserCellController } from "./controller";
import { LmcLaser } from "./lmc/laser";
import { MockLmcTransport } from "./lmc/usb";
import { Cmd } from "./lmc/protocol";

const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 1 };

/** A closed comb outline (LWPOLYLINE) `teeth` teeth wide, `heightUnits` tall, in DXF units $INSUNITS = units. */
function combDxf(teeth: number, heightUnits: number, units: number): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < teeth; i++) { pts.push([i * 2, 0], [i * 2, heightUnits], [i * 2 + 1, heightUnits], [i * 2 + 1, 0.001]); }
  pts.push([teeth * 2, 0]);
  const L = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(units), "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "70", "1"];
  for (const [x, y] of pts) L.push("10", String(x), "20", String(y));
  L.push("0", "ENDSEC", "0", "EOF");
  return L.join("\n");
}

describe("round 5 time estimate", () => {
  test("V5-E1 opening a 30 kB DXF drawn in metres blocks the core for seconds in the time estimate (synchronous, unbounded)", async () => {
    const home = await mkdtemp(join(tmpdir(), "r5-est-"));
    const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(async () => new MockLmcTransport(0), lmcOptions) });
    await c.configure({ laser: { driver: "usb-lmc" } });
    const text = combDxf(400, 4, 6); // 4 m tall comb, 400 teeth (units: metres)
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t = performance.now();
    const r = await c.importArt({ fileName: "plan.dxf", format: "dxf", text });
    const ms = performance.now() - t;
    clearInterval(timer);
    const t2 = performance.now();
    await c.jobView(); // what the job editor polls (also after every pause / resume / stop click)
    expect(ms).toBeLessThan(2000);
  }, 300_000);

  test("V5-E2 Stop is delayed while the core computes jobView for an in-field job (the editor refetches job_view after every Pause / Resume)", async () => {
    const home = await mkdtemp(join(tmpdir(), "r5-est2-"));
    const mock = new MockLmcTransport(1_000_000);
    mock.replyDelay = () => Bun.sleep(1);
    const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(async () => mock, { ...lmcOptions, maxPowerPct: 100 }) });
    await c.configure({ laser: { driver: "usb-lmc" } });
    let d = "";
    for (let i = 0; i < 150; i++) d += `M${i * 0.4} 0 V60 H${i * 0.4 + 0.2} V0.5 Z `;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="60mm" viewBox="0 0 60 60"><path d="${d}"/></svg>`;
    await c.importArt({ fileName: "comb.svg", format: "svg", text: svg });
    // The "Remove copper (PCB, 70 mm lens)" preset.
    await c.updateJob({ settings: { powerPct: 100, speedMmPerS: 500, frequencyKhz: 40, passes: 8, intervalMm: 0.015, angleDeg: 0, angleStepDeg: 90 }, positionMm: { x: 0, y: 0 } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.run({ boards: 1, mode: "laser-only" });
    while ((await c.snapshot({ probe: false })).run.step !== "mark" || !mock.singles.some(x => x.op === Cmd.ExecuteList)) await Bun.sleep(5);
    await c.pause();
    await c.resume();
    // The editor now refetches job_view; the operator presses Stop 100 ms later.
    const view = c.jobView();
    const pressed = performance.now() + 100;
    let stopSentAt = 0;
    setTimeout(() => { void c.stop(); }, 100);
    const write = mock.write.bind(mock);
    mock.write = async p => { if (!stopSentAt && p.length === 12 && p[0] === Cmd.StopExecute) stopSentAt = performance.now(); return write(p); };
    await view;
    while (!stopSentAt) await Bun.sleep(5);
    const latency = stopSentAt - pressed;
    await c.settled();
    expect(latency).toBeLessThan(250);
  }, 120_000);
});
