/** Regression tests from the fifth review (2026-11-27): hostile and look-alike job files. Each failed before its fix. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaserCellController } from "./controller";
import { LmcLaser } from "./lmc/laser";
import { MockLmcTransport } from "./lmc/usb";

const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 100, initBoard: false, frameSeconds: 1, pollMs: 1 };
const rect = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${w}mm" viewBox="0 0 ${w} ${w}"><rect width="${w}" height="${w}"/></svg>`;

describe("round 5 job files", () => {
  test("V5-J1 a schema-valid job file with huge coordinates hangs readJob+jobView / load (time estimate never ends)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r5-job-"));
    const path = join(dir, "huge.lmc.json");
    // Valid per LmcJobFileSchema: finite numbers, sane settings. 1e12 mm tall at 0.03 mm spacing = 3e13 scan lines.
    await writeFile(path, JSON.stringify({ boardMm: { width: 10, height: 1e12 }, ablate: [[[0, 0], [10, 0], [10, 1e12], [0, 1e12]]], settings: { powerPct: 10, speedMmPerS: 1000, frequencyKhz: 40, passes: 1, intervalMm: 0.03, angleDeg: 0, angleStepDeg: 0 } }));
    const script = `import { readJob, jobView } from "./src/lmc/job-file"; const j = await readJob(${JSON.stringify(path)}); jobView(j, "x", { fieldMm: 70, defaultCenterMm: { x: 0, y: 0 }, maxPowerPct: 20 }); console.log("finished");`;
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    let killed = false;
    const timer = setTimeout(() => { killed = true; proc.kill(); }, 5000);
    await proc.exited;
    clearTimeout(timer);
    const out = await new Response(proc.stdout).text();
    expect(killed).toBe(false);
  }, 20_000);

  test("V5-J2 two different drawings whose names map to the same stem: the second silently inherits the first's power, passes and position", async () => {
    const home = await mkdtemp(join(tmpdir(), "r5-stem-"));
    const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(async () => new MockLmcTransport(0), lmcOptions) });
    await c.configure({ laser: { driver: "usb-lmc" } });
    await c.importArt({ fileName: "โลโก้.svg", format: "svg", text: rect(10) }); // Thai name -> stem "drawing"
    await c.updateJob({ settings: { powerPct: 100, speedMmPerS: 300, frequencyKhz: 40, passes: 8, intervalMm: 0.015, angleDeg: 0, angleStepDeg: 90 }, positionMm: { x: 20, y: 20 } });
    const other = await c.importArt({ fileName: "ป้าย.svg", format: "svg", text: rect(5) }); // another file, also -> "drawing"
    expect(other.job.settings.powerPct).toBeLessThanOrEqual(30); // "a new drawing starts gentle (FR4 marking preset)"
  });
});
