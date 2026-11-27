/** The laser cell's job editor actions (fabPlane USB / Wi-Fi driver): drawings, settings, placement, pause. */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaserCellController } from "./controller";
import { LmcLaser } from "./lmc/laser";
import { Cmd } from "./lmc/protocol";
import { MockLmcTransport } from "./lmc/usb";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));
const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 1 };
const svg = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><rect x="0" y="0" width="${w}" height="${h}"/></svg>`;

async function cell(mock = new MockLmcTransport(0)) {
  const home = await mkdtemp(join(tmpdir(), "jobctl-"));
  const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(async () => mock, lmcOptions) });
  await c.configure({ laser: { driver: "usb-lmc" } });
  return { c, home, mock };
}

describe("job editor", () => {
  test("no job yet: a plain explanation and the presets", async () => {
    const { c } = await cell();
    const v = await c.jobView();
    expect(v.job).toBeNull();
    expect(v.error).toMatch(/No laser job yet/);
    expect(v.presets.length).toBeGreaterThan(3);
  });

  test("opening a drawing makes it the job: true size, gentle start settings, power cap shown", async () => {
    const { c } = await cell();
    const r = await c.importArt({ fileName: "Logo (final).svg", format: "svg", text: svg(20, 10) });
    expect(r.job.boardMm.width).toBeCloseTo(20, 3);
    expect(r.job.boardMm.height).toBeCloseTo(10, 3);
    expect(r.job.source).toBe("file");
    expect(r.job.settings.powerPct).toBeLessThanOrEqual(30);
    expect((await c.jobView()).job?.name).toBe("Logo-final");
    const bigger = await c.importArt({ fileName: "Logo (final).svg", format: "svg", text: svg(20, 10), widthMm: 40, rotateDeg: 90 });
    expect(bigger.job.boardMm.width).toBeCloseTo(40, 3);
    expect(bigger.job.boardMm.height).toBeCloseTo(80, 3);
  });

  test("settings and position are saved, kept when the drawing is opened again, and checked", async () => {
    const { c } = await cell();
    await c.importArt({ fileName: "tag.svg", format: "svg", text: svg(10, 10) });
    const settings = { powerPct: 15, speedMmPerS: 800, frequencyKhz: 50, passes: 2, intervalMm: 0.04, angleDeg: 45, angleStepDeg: 90 };
    await c.updateJob({ settings, positionMm: { x: 5, y: -5 }, edge: { powerPct: 15, speedMmPerS: 300, frequencyKhz: 50, passes: 1 } });
    const again = await c.importArt({ fileName: "tag.svg", format: "svg", text: svg(10, 10) });
    expect(again.job.settings).toEqual(settings);
    expect(again.job.positionMm).toEqual({ x: 5, y: -5 });
    expect(again.job.edge?.passes).toBe(1);
    const jig = await c.updateJob({ positionMm: null, edge: null });
    expect(jig.positionFromJob).toBe(false);
    expect(jig.edge).toBeNull();
    expect(await failure(c.updateJob({ settings: { ...settings, intervalMm: 0.0005 } }))).toMatch(/line spacing .* out of range/);
  });

  test("a file that is not a drawing gets a clear message", async () => {
    const { c } = await cell();
    expect(await failure(c.importArt({ fileName: "notes.svg", format: "svg", text: "hello" }))).toMatch(/Could not open notes\.svg/);
  });
});

describe("pause from the cell", () => {
  test("pause and resume a running job; the status shows paused and the time left", async () => {
    const mock = new MockLmcTransport(1_000_000);
    mock.replyDelay = () => Bun.sleep(1);
    const { c } = await cell(mock);
    await c.importArt({ fileName: "big.svg", format: "svg", text: svg(30, 30) });
    await c.updateJob({ settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 0.01, angleDeg: 0, angleStepDeg: 0 } });
    expect(await failure(c.pause())).toMatch(/Nothing is running/);
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.run({ boards: 1, mode: "laser-only" });
    while ((await c.snapshot({ probe: false })).run.step !== "mark") await Bun.sleep(2);
    await Bun.sleep(20);
    await c.pause();
    const paused = (await c.snapshot({ probe: false })).run;
    expect(paused.paused).toBe(true);
    expect(typeof paused.remainingSeconds).toBe("number");
    await c.resume();
    expect((await c.snapshot({ probe: false })).run.paused).toBe(false);
    expect(mock.singles.map(x => x.op)).toEqual(expect.arrayContaining([Cmd.StopList, Cmd.RestartList]));
    await c.stop();
  });
});
