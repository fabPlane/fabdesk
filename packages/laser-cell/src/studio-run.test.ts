/**
 * Start / Stop through the controller on the ComMarker Studio window route, against a fake Studio window:
 * the same path the Laser Controller's Start and Stop buttons take (laser_cell run / stop).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaserCellController } from "./controller";
import { StudioWindowLaser, type StudioUi, type StudioUiState } from "./studio-window";

const ready: StudioUiState = {
  running: true, startLabel: "Start(F2)", startEnabled: true, connection: "Connected", doorSensor: false,
  buttons: ["Preview", "Start(F2)", "Focus"], dialogs: [], elements: 202,
};

/** Studio that marks for `busyReads` status reads after Start, and returns to ready at once on Stop. */
function fakeStudio(busyReads: number, base: Partial<StudioUiState> = {}) {
  const presses: string[] = [];
  let busyLeft = 0;
  const ui: StudioUi = {
    async read() {
      if (busyLeft > 0) { busyLeft--; return { ...ready, ...base, startLabel: "Stop(F2)" }; }
      return { ...ready, ...base };
    },
    async press(target) {
      presses.push(target);
      if (target === "start") busyLeft = busyReads;
      else busyLeft = 0;
      return { ok: true, label: target };
    },
    async load() { return { ok: true, values: {}, log: [] }; },
  };
  return { ui, presses };
}

async function cell(studio: ReturnType<typeof fakeStudio>) {
  const home = await mkdtemp(join(tmpdir(), "laser-studio-run-"));
  const c = new LaserCellController({
    home,
    makeLaser: async () => new StudioWindowLaser(studio.ui, { completion: "watch", markSeconds: 1, marginSeconds: 0, pollMs: 5, startTimeoutMs: 500 }),
  });
  // Test fixture only: the real confirmation is the person at the cell ticking the UV-guard box.
  await c.configure({ laser: { driver: "studio-window" }, safetyConfirmed: true });
  return c;
}

describe("Start / Stop on the Studio window route", () => {
  test("Start presses Studio's Start for each board and waits until Studio is done", async () => {
    const studio = fakeStudio(3);
    const c = await cell(studio);
    await c.run({ boards: 2, mode: "laser-only" });
    await c.settled();
    const snap = await c.snapshot({ probe: false });
    expect(snap.run).toMatchObject({ active: false, done: 2, error: null });
    expect(studio.presses.filter(p => p === "start")).toHaveLength(2);
  });

  test("Stop during marking presses Studio's Stop and ends the run", async () => {
    const studio = fakeStudio(100_000);
    const c = await cell(studio);
    await c.run({ boards: 3, mode: "laser-only" });
    for (let i = 0; i < 200 && !studio.presses.includes("start"); i++) await Bun.sleep(5);
    await Bun.sleep(30);
    await c.stop();
    await c.settled();
    const snap = await c.snapshot({ probe: false });
    expect(snap.run.active).toBe(false);
    expect(snap.run.done).toBe(0);
    expect(snap.run.error).toMatch(/stop/i);
    // Stop presses Studio's Stop at once, and the cycle's own cleanup presses it again (harmless when Studio is
    // already idle: only a button labelled Stop/Abort/Cancel is ever pressed). Start is never pressed again.
    expect(studio.presses[0]).toBe("start");
    expect(studio.presses.slice(1).length).toBeGreaterThan(0);
    expect(studio.presses.slice(1).every(p => p === "stop")).toBe(true);
  });

  test("Start is refused before pressing anything when Studio shows the laser disconnected", async () => {
    const studio = fakeStudio(3, { connection: "Disconnected" });
    const c = await cell(studio);
    await c.run({ boards: 1, mode: "laser-only" });
    await c.settled();
    const snap = await c.snapshot({ probe: false });
    expect(snap.run.error).toMatch(/Disconnected/);
    expect(studio.presses.filter(p => p === "start")).toEqual([]);
  });
});
