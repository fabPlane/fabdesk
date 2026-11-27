import { describe, expect, test } from "bun:test";
import { StudioWindowLaser, studioBusy, studioMismatches, type StudioJobSpec, type StudioUi, type StudioUiState } from "./studio-window";

const ready: StudioUiState = {
  running: true, startLabel: "Start(F2)", startEnabled: true, connection: "Connected", doorSensor: false,
  buttons: ["Preview", "Start(F2)", "Focus"], dialogs: [], elements: 202,
};

/** Fake Studio: after Start it shows `busyLabel` for `busyReads` reads, then returns to ready. */
function fakeStudio(options: { busyReads?: number; busyLabel?: string; neverBusy?: boolean; dialogAfter?: number } = {}) {
  const pressed: string[] = [];
  let reads = 0;
  let startedAt = -1;
  const ui: StudioUi & { state: StudioUiState; pressed: string[] } = {
    state: { ...ready },
    pressed,
    async read() {
      reads++;
      if (startedAt >= 0 && options.dialogAfter !== undefined && reads - startedAt > options.dialogAfter) return { ...ui.state, dialogs: ["Ask: Device error"] };
      if (startedAt >= 0 && !options.neverBusy && reads - startedAt <= (options.busyReads ?? 3)) return { ...ui.state, startLabel: options.busyLabel ?? "Stop(F2)" };
      return ui.state;
    },
    async press(target) {
      pressed.push(target);
      if (target === "start") startedAt = reads;
      return { ok: true, label: target };
    },
    async load(spec) {
      pressed.push(`load ${spec.file}`);
      return { ok: true, values: { width: String(spec.widthMm), height: String(spec.heightMm), speed: "500", passes: "1" }, log: ["imported"] };
    },
  };
  return ui;
}

const opts = { completion: "watch" as const, markSeconds: 1, marginSeconds: 0, pollMs: 1, startTimeoutMs: 30 };

describe("studio window laser", () => {
  test("busy is inferred from the Start button", () => {
    expect(studioBusy(ready)).toBe(false);
    expect(studioBusy({ ...ready, startLabel: "Stop(F2)" })).toBe(true);
    expect(studioBusy({ ...ready, startEnabled: false })).toBe(true);
    expect(studioBusy({ ...ready, startLabel: null })).toBe(false);
  });

  test("status explains what is wrong", async () => {
    const ui = fakeStudio();
    const laser = new StudioWindowLaser(ui, opts);
    expect((await laser.status()).state).toBe("idle");
    ui.state = { ...ready, running: false };
    expect((await laser.status()).detail).toMatch(/not open/);
    ui.state = { ...ready, connection: "Disconnected" };
    expect((await laser.status()).state).toBe("offline");
    ui.state = { ...ready, dialogs: ["Ask: Please add at least one element"] };
    expect((await laser.status()).detail).toMatch(/Please add at least one element/);
    ui.state = { ...ready, startLabel: null, elements: 5 };
    expect((await laser.status()).detail).toMatch(/administrator/);
    ui.state = { ...ready, startLabel: null, elements: 40 };
    expect((await laser.status()).detail).toMatch(/home page/);
  });

  test("start presses Start, waitDone follows busy then idle", async () => {
    const ui = fakeStudio({ busyReads: 3 });
    const laser = new StudioWindowLaser(ui, opts);
    await laser.start();
    await laser.waitDone({ timeoutMs: 5000 });
    expect(ui.pressed).toEqual(["start"]);
    expect([...laser.seenBusyLabels]).toEqual(["Stop(F2) / Connected"]);
  });

  test("start refuses when Studio is not ready", async () => {
    const ui = fakeStudio();
    ui.state = { ...ready, connection: "Disconnected" };
    await expect(new StudioWindowLaser(ui, opts).start()).rejects.toThrow(/Disconnected/);
    expect(ui.pressed).toEqual([]);
  });

  test("a Start button that never changes is an error, not a finished board", async () => {
    const ui = fakeStudio({ neverBusy: true });
    const laser = new StudioWindowLaser(ui, opts);
    await laser.start();
    await expect(laser.waitDone({ timeoutMs: 5000 })).rejects.toThrow(/never changed/);
  });

  test("a dialog while marking stops the cycle", async () => {
    const ui = fakeStudio({ busyReads: 50, dialogAfter: 2 });
    const laser = new StudioWindowLaser(ui, opts);
    await laser.start();
    await expect(laser.waitDone({ timeoutMs: 5000 })).rejects.toThrow(/Device error/);
  });

  test("timer completion waits the job time, then checks Studio is idle", async () => {
    const ui = fakeStudio({ neverBusy: true });
    const laser = new StudioWindowLaser(ui, { ...opts, completion: "timer", markSeconds: 0.05 });
    const t = Date.now();
    await laser.start();
    await laser.waitDone({ timeoutMs: 5000 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
  });

  test("stop presses Studio's stop", async () => {
    const ui = fakeStudio();
    await new StudioWindowLaser(ui, opts).stop();
    expect(ui.pressed).toEqual(["stop"]);
  });
});

describe("loading a job into Studio", () => {
  const spec: StudioJobSpec = { file: "C:/job.studio.svg", widthMm: 20, heightMm: 10, settings: { speedMmPerS: 500, passes: 8 } };

  test("reports fields Studio did not take", async () => {
    const ui = fakeStudio();
    const result = await new StudioWindowLaser(ui, opts).loadJob(spec);
    expect(ui.pressed).toEqual(["load C:/job.studio.svg"]);
    expect(result.log.at(-1)).toBe("check in Studio: passes is 1 (wanted 8)");
  });

  test("refuses while Studio is marking or closed", async () => {
    const ui = fakeStudio();
    ui.state = { ...ready, startLabel: "Stop(F2)" };
    await expect(new StudioWindowLaser(ui, opts).loadJob(spec)).rejects.toThrow(/busy/);
    ui.state = { ...ready, running: false };
    await expect(new StudioWindowLaser(ui, opts).loadJob(spec)).rejects.toThrow(/not open/);
  });

  test("mismatch tolerance follows Studio rounding", () => {
    expect(studioMismatches(spec, { width: "20.00", height: "10", speed: "500" })).toEqual([]);
    expect(studioMismatches(spec, { width: "70", speed: "abc" })).toEqual(["width is 70 (wanted 20)", "speed is abc (wanted 500)"]);
  });
});
