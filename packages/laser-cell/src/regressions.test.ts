/**
 * Regression tests for the bugs found in the 2026-11-27 review. Each test failed (or would have) before
 * its fix. Await errors with `failure()`: bun hangs on expect(p).rejects once p has already rejected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arm, DEFAULT_ARM_CONFIG } from "./arm";
import { runCycle, type CellPoses } from "./cell";
import { LaserCellController, SAVED_SECRET } from "./controller";
import { SimulatedLaser, StudioFootswitchLaser, type RelayLink } from "./lasers";
import { openBridgeLmc, startLmcBridge } from "./lmc/bridge";
import { buildMarkJob, validateSettings, type MarkSettings } from "./lmc/job";
import { LmcLaser, type LmcJobFile } from "./lmc/laser";
import { Cmd, List, decodeList } from "./lmc/protocol";
import { MockLmcTransport } from "./lmc/usb";
import { St3215Bus } from "./st3215";
import { fakeServos } from "./st3215.test";
import { StudioWindowLaser, runPowerShell, type StudioUi, type StudioUiState } from "./studio-window";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!().catch(() => undefined); });

const square: Array<[number, number]> = [[5, 5], [15, 5], [15, 15], [5, 15]];
const job: LmcJobFile = { boardMm: { width: 20, height: 20 }, ablate: [square], settings: { powerPct: 50, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };

async function jobFile(j: LmcJobFile = job): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "regress-"));
  await writeFile(join(dir, "job.lmc.json"), JSON.stringify(j));
  return join(dir, "job.lmc.json");
}

/** Mock board that logs singles and list packets in one ordered list. */
class OrderedMock extends MockLmcTransport {
  readonly events: string[] = [];
  override async write(packet: Uint8Array) {
    if (packet.length === 0xc00) this.events.push("LIST");
    else this.events.push(`0x${decodeList([packet])[0]!.op.toString(16)}`);
    return super.write(packet);
  }
}

const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 100, initBoard: false, frameSeconds: 1, pollMs: 1 };

describe("USB driver", () => {
  test("a stop during the last READY poll: nothing is sent or executed after it", async () => {
    const mock = new OrderedMock(1_000_000);
    let release!: () => void;
    let polls = 0;
    mock.replyDelay = async op => { if (op === Cmd.GetVersion && ++polls === 1) await new Promise<void>(r => { release = r; }); };
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile());
    const run = failure(l.start());
    while (!release) await Bun.sleep(1);
    const stopping = l.stop();
    release();
    await stopping;
    expect(await run).toMatch(/stopped/);
    const afterStop = mock.events.slice(mock.events.indexOf(`0x${Cmd.StopExecute.toString(16)}`));
    expect(afterStop).not.toContain("LIST");
    expect(afterStop).not.toContain(`0x${Cmd.ExecuteList.toString(16)}`);
    expect(mock.events).not.toContain(`0x${Cmd.ExecuteList.toString(16)}`);
  });

  test("settings are refused, never wrapped: frequency 0.1 kHz, speed 0", () => {
    const s: MarkSettings = { powerPct: 10, speedMmPerS: 500, travelMmPerS: 2000, frequencyKhz: 0.1, passes: 1, intervalMm: 0.05, angleDeg: 0, angleStepDeg: 0, laserOnDelayUs: 100, laserOffDelayUs: 100, polygonDelayUs: 100, jumpDelayUs: 200 };
    expect(() => validateSettings(s)).toThrow(/frequency/);
    expect(() => validateSettings({ ...s, frequencyKhz: 40, speedMmPerS: 0 })).toThrow(/speed/);
    expect(() => validateSettings({ ...s, frequencyKhz: 40, passes: 2.5 })).toThrow(/passes/);
  });

  test("concurrent callers share one connection and one board initialisation", async () => {
    let opens = 0;
    const mock = new MockLmcTransport(0);
    const l = new LmcLaser(async () => { opens++; await Bun.sleep(5); return mock; }, { ...lmcOptions, initBoard: true });
    await Promise.all([l.probe(), l.status(), l.probe()]);
    expect(opens).toBe(1);
    expect(mock.singles.filter(c => c.op === Cmd.Reset)).toHaveLength(1);
  });

  test("fiber source: the MO opens before the job runs and closes after", async () => {
    const mock = new OrderedMock(2);
    const l = new LmcLaser(async () => mock, { ...lmcOptions, source: "fiber" });
    await l.load(await jobFile());
    await l.start();
    await l.waitDone({ timeoutMs: 5000 });
    const mo = mock.singles.filter(c => c.op === Cmd.FiberSetMo).map(c => c.params[0]);
    expect(mo[0]).toBe(1);
    expect(mo.at(-1)).toBe(0);
    expect(mock.events.indexOf(`0x${Cmd.FiberSetMo.toString(16)}`)).toBeLessThan(mock.events.indexOf(`0x${Cmd.ExecuteList.toString(16)}`));
  });

  test("the first jump carries its distance from the field centre", () => {
    const s: MarkSettings = { powerPct: 10, speedMmPerS: 500, travelMmPerS: 2000, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0, laserOnDelayUs: 100, laserOffDelayUs: 100, polygonDelayUs: 100, jumpDelayUs: 200 };
    const cmds = decodeList(buildMarkJob([square], { sizeMm: 70, centerMm: [0, 0], boardMm: { width: 20, height: 20 } }, s, { source: "co2", pins: { laser: 0, light: 8 } }).packets);
    expect(cmds.find(c => c.op === List.JumpTo)!.params[3]).toBeGreaterThan(0);
  });

  test("a preview can be stopped from the controller, and nothing else can start meanwhile", async () => {
    const home = await mkdtemp(join(tmpdir(), "regress-cell-"));
    const path = await jobFile();
    await writeFile(join(home, "F-Cu.lmc.json"), await Bun.file(path).text());
    const mock = new MockLmcTransport(1_000_000);
    const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(async () => mock, lmcOptions) });
    await c.configure({ laser: { driver: "usb-lmc", jobPath: join(home, "F-Cu.lbrn2") } });
    await c.configure({ safetyConfirmed: true }); // test fixture; on the machine the person at the cell ticks it
    const preview = failure(c.preview(30));
    while (!(await c.snapshot({ probe: false })).operation) await Bun.sleep(2);
    expect(await failure(c.run({ boards: 1, mode: "laser-only" }))).toMatch(/busy/);
    await c.stop();
    expect(await preview).toMatch(/stopped/);
    expect((await c.snapshot({ probe: false })).operation).toBeNull();
    expect(mock.singles.map(x => x.op)).toContain(Cmd.StopExecute);
  });
});

describe("Wi-Fi bridge", () => {
  async function bridge(mock: MockLmcTransport, takeoverMs?: number) {
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => mock, ...(takeoverMs !== undefined ? { takeoverMs } : {}) });
    cleanups.push(b.stop);
    return b.port;
  }

  test("after a timeout the link is dropped, so a late reply is never read as the next answer", async () => {
    const mock = new MockLmcTransport(0, [0x1111, 2, 3]);
    let slow = true;
    mock.replyDelay = async () => { if (slow) { slow = false; await Bun.sleep(400); } };
    const port = await bridge(mock);
    const l = new LmcLaser(() => openBridgeLmc("127.0.0.1", port, "k", 150), lmcOptions);
    cleanups.push(() => l.close());
    expect((await l.status()).state).toBe("offline"); // timed out, link dropped
    await Bun.sleep(500);
    const p = await l.probe(); // reconnects; the answer is to this request
    expect(p.version[0]).toBe(0x1111);
  });

  test("when the driving computer disconnects mid-job the bridge stops the board", async () => {
    const mock = new OrderedMock(1_000_000);
    const port = await bridge(mock);
    const l = new LmcLaser(() => openBridgeLmc("127.0.0.1", port, "k"), lmcOptions);
    await l.load(await jobFile());
    await l.start();
    await l.close(); // laptop leaves
    for (let i = 0; i < 100 && !mock.events.includes(`0x${Cmd.StopExecute.toString(16)}`); i++) await Bun.sleep(5);
    const tail = mock.events.slice(mock.events.lastIndexOf(`0x${Cmd.StopExecute.toString(16)}`));
    expect(tail).toEqual([`0x${Cmd.StopExecute.toString(16)}`, `0x${Cmd.ResetList.toString(16)}`, `0x${Cmd.WritePort.toString(16)}`]);
  });

  test("a silent driving computer can be replaced; the board is stopped first", async () => {
    const mock = new OrderedMock(0);
    const port = await bridge(mock, 100);
    const first = await openBridgeLmc("127.0.0.1", port, "k");
    cleanups.push(() => first.close());
    expect(await failure(openBridgeLmc("127.0.0.1", port, "k"))).toMatch(/already driving/);
    await Bun.sleep(150);
    const second = await openBridgeLmc("127.0.0.1", port, "k");
    cleanups.push(() => second.close());
    for (let i = 0; i < 100 && !mock.events.includes(`0x${Cmd.StopExecute.toString(16)}`); i++) await Bun.sleep(5);
    expect(mock.events).toContain(`0x${Cmd.StopExecute.toString(16)}`);
  });
});

describe("controller", () => {
  async function cell(makeLaser?: () => Promise<import("./cell").LaserDriver>) {
    const home = await mkdtemp(join(tmpdir(), "regress-ctl-"));
    const c = new LaserCellController({ home, makeLaser: makeLaser ?? (async () => new SimulatedLaser(200)) });
    await c.configure({ laser: { driver: "simulator" } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    return { c, home };
  }

  test("two Starts at once: the second is refused", async () => {
    const { c } = await cell();
    const first = c.run({ boards: 1, mode: "laser-only" });
    expect(await failure(c.run({ boards: 1, mode: "laser-only" }))).toMatch(/running/);
    await first;
    await c.stop();
  });

  test("the UV-guard confirmation does not survive a restart or a change of route", async () => {
    const { c, home } = await cell();
    expect((await c.snapshot({ probe: false })).config.safetyConfirmed).toBe(true);
    await c.configure({ laser: { driver: "studio-window" } });
    expect((await c.snapshot({ probe: false })).config.safetyConfirmed).toBe(false);
    await c.configure({ safetyConfirmed: true });
    const again = new LaserCellController({ home });
    expect((await again.snapshot({ probe: false })).config.safetyConfirmed).toBe(false);
  });

  test("the bridge access key is never shown, and sending the placeholder back keeps it", async () => {
    const { c, home } = await cell();
    expect((await c.configure({ laser: { lmc: { token: "secret-key" } } })).laser.lmc.token).toBe(SAVED_SECRET);
    const snap = await c.snapshot({ probe: false });
    expect(snap.config.laser.lmc.token).toBe(SAVED_SECRET);
    await c.configure({ laser: { lmc: { token: SAVED_SECRET, host: "10.0.0.5" } } });
    expect(JSON.parse(await Bun.file(join(home, "laser-cell.json")).text()).laser.lmc.token).toBe("secret-key");
  });

  test("an unreadable laser-cell.json is kept, not overwritten with defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "regress-bad-"));
    await writeFile(join(home, "laser-cell.json"), "{ not json");
    const c = new LaserCellController({ home });
    await c.configure({ laser: { driver: "simulator" } });
    expect((await readdir(home)).some(f => f.startsWith("laser-cell.unreadable-"))).toBe(true);
  });

  test("foot-switch: press needs the UV-guard confirmation; a job longer than the limit never fires", async () => {
    const calls: string[] = [];
    const relay: RelayLink = { pressed: false, async set(on) { calls.push(`set ${on}`); }, async pulse() { calls.push("pulse"); }, async close() {} };
    const home = await mkdtemp(join(tmpdir(), "regress-fs-"));
    const c = new LaserCellController({ home, makeLaser: async cfg => new StudioFootswitchLaser({ relay, markSeconds: cfg.laser.markSeconds, marginSeconds: cfg.laser.marginSeconds }) });
    await c.configure({ laser: { driver: "studio-footswitch", relayPort: "COM9", markSeconds: 7300, markTimeoutMinutes: 120 } });
    expect(await failure(c.footswitch("press"))).toMatch(/UV guard/);
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.run({ boards: 1, mode: "laser-only" });
    await c.settled();
    expect((await c.snapshot({ probe: false })).run.error).toMatch(/longer than the time limit/);
    expect(calls).not.toContain("pulse");
  });

  test("foot-switch: after a stop the laser still counts as busy until the job time has passed", async () => {
    const relay: RelayLink = { pressed: false, async set() {}, async pulse() {}, async close() {} };
    const l = new StudioFootswitchLaser({ relay, markSeconds: 60, marginSeconds: 0 });
    await l.start();
    await l.stop();
    expect((await l.status()).state).toBe("busy");
  });

  test("laser only with a connected arm away from “Clear of laser” is refused", async () => {
    const servos = fakeServos([1, 2, 3]);
    const arm = new Arm(new St3215Bus(servos.link), { ...DEFAULT_ARM_CONFIG, jointIds: [1, 2], gripperId: 3, moveTimeoutMs: 2000 });
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    const poses: CellPoses = { clear: { 1: 3200, 2: 1800 } };
    setPos(1, 2600); setPos(2, 2500); // in the jig
    const laser = new SimulatedLaser(1);
    expect(await failure(runCycle(arm, laser, poses, { frameSeconds: 0, markTimeoutMs: 5000, laserOnly: true, dryRun: false }))).toMatch(/not at “Clear of laser”/);
    expect(laser.log).not.toContain("start");
    setPos(1, 3200); setPos(2, 1800);
    await runCycle(arm, laser, poses, { frameSeconds: 0, markTimeoutMs: 5000, laserOnly: true, dryRun: false });
    expect(laser.log).toContain("start");
  });
});

describe("ComMarker Studio route", () => {
  const ready: StudioUiState = { running: true, startLabel: "Start(F2)", startEnabled: true, connection: "Connected", doorSensor: false, buttons: [], dialogs: [], elements: 202 };

  test("Stop pressed while Start is still being checked: Start is never pressed", async () => {
    const presses: string[] = [];
    let release!: () => void;
    const ui: StudioUi = {
      read: () => new Promise(r => { release = () => r(ready); }),
      async press(target, options) { if (options?.cancelled?.()) return { ok: false, error: "cancelled" }; presses.push(target); return { ok: true }; },
      async load() { return { ok: true, log: [] }; },
    };
    const l = new StudioWindowLaser(ui, { completion: "watch", markSeconds: 1, marginSeconds: 0 });
    const start = failure(l.start());
    while (!release) await Bun.sleep(1);
    await l.stop();
    release();
    expect(await start).toMatch(/stopped/);
    expect(presses).toEqual(["stop"]);
  });

  test("a missing Start button is never taken as “finished”", async () => {
    let reads = 0;
    const ui: StudioUi = {
      async read() { reads++; return reads <= 2 ? { ...ready, startLabel: "Stop(F2)" } : reads <= 8 ? { ...ready, startLabel: null, elements: 40 } : ready; },
      async press() { return { ok: true }; },
      async load() { return { ok: true, log: [] }; },
    };
    const l = new StudioWindowLaser(ui, { completion: "watch", markSeconds: 1, marginSeconds: 0, pollMs: 1 });
    await l.waitDone({ timeoutMs: 5000 });
    expect(reads).toBeGreaterThanOrEqual(10); // waited through the unknown reads until Start came back
  });

  test.if(process.platform === "win32")("PowerShell inputs far beyond the command-line limit go through", async () => {
    const big = "x".repeat(60_000);
    const out = await runPowerShell(`[Console]::Out.Write($env:FABPLANE_ARGS.Length)`, 20_000, { FABPLANE_ARGS: big });
    expect(Number(out)).toBe(60_000);
  });
});

describe("arm moves", () => {
  test("Stop ends an arm move (Arm setup → Go) at once, and the cell is free again", async () => {
    const home = await mkdtemp(join(tmpdir(), "regress-arm-"));
    // Joint 1 cannot go below 2000, so a move to 1000 never arrives on its own.
    const servos = fakeServos([1, 2, 3], { blocked: { 1: 2000 } });
    const c = new LaserCellController({ home, openArmBus: async () => new St3215Bus(servos.link), makeLaser: async () => new SimulatedLaser(1) });
    await c.configure({ arm: { port: "COM7", jointIds: [1, 2], gripperId: 3 }, laser: { driver: "simulator" } });
    await c.connectArm();
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    setPos(1, 1000); setPos(2, 1800);
    await c.teach("clear");
    setPos(1, 2048); setPos(2, 2048);
    const started = Date.now();
    const move = failure(c.moveTo("clear"));
    while (!(await c.snapshot({ probe: false })).operation) await Bun.sleep(2);
    await c.stop();
    expect(await move).toMatch(/stopped/);
    expect(Date.now() - started).toBeLessThan(2000); // not the 8 s move timeout
    expect((await c.snapshot({ probe: false })).operation).toBeNull();
    await c.dispose();
  });
});
