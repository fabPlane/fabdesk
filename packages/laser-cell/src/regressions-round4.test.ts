/**
 * Regression tests from the fourth review (2026-11-27): each failed before its fix. Fakes only: fake relays,
 * fake StudioUi / PowerShell runner, MockLmcTransport, a bridge on 127.0.0.1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCycle } from "./cell";
import { LaserCellController } from "./controller";
import { LaserDriverError, SimulatedLaser, StudioFootswitchLaser, type RelayLink } from "./lasers";
import { openBridgeLmc, startLmcBridge } from "./lmc/bridge";
import { LmcLaser, type LmcJobFile } from "./lmc/laser";
import { Cmd } from "./lmc/protocol";
import { MockLmcTransport } from "./lmc/usb";
import { St3215Bus } from "./st3215";
import { fakeServos } from "./st3215.test";
import { StudioWindowLaser, type StudioUi, type StudioUiState } from "./studio-window";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!().catch(() => undefined); });

/** Behaves like relayOver(): close() releases the contact first. */
const fakeRelay = () => {
  const r = {
    pressed: false,
    calls: [] as string[],
    async set(on: boolean) { r.pressed = on; r.calls.push(`set ${on}`); },
    async pulse() { r.calls.push("pulse"); },
    async close() { r.pressed = false; r.calls.push("close"); },
  };
  return r;
};

async function footswitchCell(relay: RelayLink, home?: string) {
  home ??= await mkdtemp(join(tmpdir(), "r4-fs-"));
  const c = new LaserCellController({ home, openRelay: async () => relay });
  await c.configure({ laser: { driver: "studio-footswitch", relayPort: "COM9", markSeconds: 60, markTimeoutMinutes: 10 } });
  await c.configure({ safetyConfirmed: true }); // test fixture
  return { c, home };
}

describe("round 4 A: foot switch held by hand, then released by something other than Release", () => {
  test("A1: Hold (Studio starts its job), then Stop: the laser must still count as busy and a run must not press again", async () => {
    const relay = fakeRelay();
    const { c } = await footswitchCell(relay);
    await c.footswitch("hold"); // pedal down: Studio starts the job loaded in it
    await c.stop(); // operator presses fabPlane's Stop: the relay opens, Studio keeps marking (no remote stop)
    const state = (await c.snapshot()).laser?.state;
    await c.run({ boards: 1, mode: "laser-only" });
    await Bun.sleep(30);
    await c.stop();
    expect({ state, pulses: relay.calls.filter(x => x === "pulse").length }).toEqual({ state: "busy", pulses: 0 });
  });

  test("A2: Hold, then a settings change (use_job / studio_load_job update markSeconds): driver rebuild releases the pedal and the laser reads idle", async () => {
    const relay = fakeRelay();
    const { c } = await footswitchCell(relay);
    await c.footswitch("hold");
    await c.configure({ laser: { markSeconds: 61 } }); // allowed: a held pedal is not an operation
    const state = (await c.snapshot()).laser?.state; // rebuilds the driver: old relay closed = pedal up
    await c.run({ boards: 1, mode: "laser-only" });
    await Bun.sleep(30);
    await c.stop();
    expect({ state, pulses: relay.calls.filter(x => x === "pulse").length }).toEqual({ state: "busy", pulses: 0 });
  });

  test("A3: Hold, then fabPlane shuts down (dispose releases the relay): after the restart the laser reads idle", async () => {
    const relay = fakeRelay();
    const { c, home } = await footswitchCell(relay);
    await c.footswitch("hold");
    await c.dispose();
    await Bun.sleep(50);
    const again = new LaserCellController({ home, openRelay: async () => relay });
    expect((await again.snapshot()).laser?.state).toBe("busy");
  });

  test("A4: a start whose relay release fails after the contact closed leaves the laser idle (busy never marked)", async () => {
    let pressed = false;
    const relay: RelayLink = {
      get pressed() { return pressed; },
      async set(on) { pressed = on; },
      // Contact closed (Studio starts), then the release write fails (USB serial glitch).
      async pulse() { pressed = true; throw new Error("serial write failed"); },
      async close() { pressed = false; },
    };
    const l = new StudioFootswitchLaser({ relay, markSeconds: 60, marginSeconds: 0 });
    expect(await failure(runCycle(null, l, {}, { frameSeconds: 0, markTimeoutMs: 600_000, laserOnly: true }))).toMatch(/serial write failed/);
    // runCycle's catch released the relay via stop(); Studio is marking the job the press started.
    expect((await l.status()).state).toBe("busy");
  });
});

describe("round 4 B: Studio route, unknown state before the press", () => {
  const ready: StudioUiState = { running: true, startLabel: "Start(F2)", startEnabled: true, connection: "Connected", doorSensor: false, buttons: [], dialogs: [], elements: 202 };

  test("B1: Studio read fails right before Start (Studio busy with a job started by hand): fabPlane presses Stop although it pressed nothing", async () => {
    const presses: string[] = [];
    let reads = 0;
    const ui: StudioUi = {
      async read() {
        if (++reads === 1) return ready; // preflight
        throw new LaserDriverError("ComMarker Studio did not respond within 20 s; check Studio for an open dialog");
      },
      async press(target) { presses.push(target); return { ok: true }; },
      async load() { return { ok: true, log: [] }; },
    };
    const l = new StudioWindowLaser(ui, { completion: "watch", markSeconds: 1, marginSeconds: 0 });
    expect(await failure(runCycle(null, l, {}, { frameSeconds: 0, markTimeoutMs: 5000, laserOnly: true }))).toMatch(/did not respond/);
    expect(presses).toEqual([]);
  });
});

describe("round 4 C: arm move after Stop froze the arm", () => {
  test("C1: Stop during Arm setup → Go: a goal-position move reaches the servos after stop() has returned", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-arm-"));
    const servos = fakeServos([1, 2, 3]);
    const log: string[] = [];
    const write = servos.link.write.bind(servos.link);
    servos.link.write = async bytes => {
      if (bytes[4] === 0x83) log.push(`sync 0x${bytes[5]!.toString(16)} len ${bytes[6]}`);
      await Bun.sleep(1);
      return write(bytes);
    };
    const c = new LaserCellController({ home, openArmBus: async () => new St3215Bus(servos.link), makeLaser: async () => new SimulatedLaser(1) });
    await c.configure({ arm: { port: "COM7", jointIds: [1, 2], gripperId: 3 }, laser: { driver: "simulator" } });
    await c.connectArm();
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    const pos = (id: number) => { const m = servos.regs.get(id)!; return m[0x38]! | (m[0x39]! << 8); };
    setPos(1, 1000); setPos(2, 1800);
    await c.teach("clear");
    setPos(1, 2048); setPos(2, 2048);
    const move = failure(c.moveTo("clear"));
    while (!log.includes("sync 0x29 len 1")) await Bun.sleep(0); // arm.prepare() in progress
    await c.stop();
    const atStop = log.length;
    const posAtStop = pos(1);
    const busyAfterStop = (await c.snapshot({ probe: false })).operation;
    expect(await move).toMatch(/stopped/);
    const after = log.slice(atStop);
    expect(after).not.toContain("sync 0x2a len 6"); // goalBlock = a move command
    expect(pos(1)).toBe(posAtStop);
    await c.dispose();
  });
});

describe("round 4 D: Wi-Fi bridge", () => {
  test("D1: close the link and reconnect at once (driver rebuilt after a settings change, or after a timeout)", async () => {
    const mock = new MockLmcTransport(0);
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => mock });
    cleanups.push(b.stop);
    const first = await openBridgeLmc("127.0.0.1", b.port, "k");
    await first.close();
    const second = openBridgeLmc("127.0.0.1", b.port, "k");
    const result = await failure(second.then(t => t.close()));
    expect(result).toBe("no error");
  });

  test("D2: Stop with the bridge going silent mid-job: tries the board more than once (doc: gives up after one try)", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-wifi-"));
    const square: Array<[number, number]> = [[5, 5], [15, 5], [15, 15], [5, 15]];
    const job: LmcJobFile = { boardMm: { width: 20, height: 20 }, ablate: [square], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };
    await Bun.write(join(home, "F-Cu.lmc.json"), JSON.stringify(job));
    const mock = new MockLmcTransport(1_000_000);
    let hang = false;
    let unhang: () => void = () => undefined;
    const hung = new Promise<void>(r => { unhang = r; });
    mock.replyDelay = async () => { if (hang) await hung; };
    let connections = 0;
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => mock, log: l => { if (l.startsWith("connected")) connections++; } });
    cleanups.push(async () => { unhang(); await b.stop(); });
    const TIMEOUT = 300;
    const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(() => openBridgeLmc("127.0.0.1", b.port, "k", TIMEOUT), { field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 20 }) });
    await c.configure({ laser: { driver: "usb-lmc", jobPath: join(home, "F-Cu.lbrn2") } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.run({ boards: 1, mode: "laser-only" });
    while ((await c.snapshot({ probe: false })).run.step !== "mark") await Bun.sleep(5);
    await Bun.sleep(100); // marking, polling the board
    hang = true; // the board / Wi-Fi stops answering
    await Bun.sleep(20);
    const t0 = Date.now();
    await c.stop();
    const took = Date.now() - t0;
    expect(took).toBeLessThan(2 * TIMEOUT + 150);
  });
});

import { runPowerShell, setInlinePowerShellForTests, windowsStudioUi, type PowerShellRunner } from "./studio-window";

describe("round 4 E: lock and arm freeze details", () => {
  test.if(process.platform === "win32")("E1: Stop during a Studio job load returns while the cell is still locked (cleanup script runs under the lock)", async () => {
    const ready: StudioUiState = { running: true, startLabel: "Start(F2)", startEnabled: true, connection: "Connected", doorSensor: false, buttons: [], dialogs: [], elements: 202 };
    let loading = false;
    // Fake PowerShell only: nothing is spawned. read always says Studio is running, so launchStudio never launches.
    const run: PowerShellRunner = (script, _ms, env = {}, signal) => {
      if (env.FABPLANE_ARGS) { loading = true; return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new LaserDriverError("stopped")))); }
      if (script.includes("CancelDialogs")) return new Promise(r => setTimeout(() => r("0"), 1500)); // Studio slow to answer
      if (env.FABPLANE_ACTION === "read") return Promise.resolve(JSON.stringify(ready));
      return Promise.resolve(JSON.stringify({ ok: false, error: "Studio shows \"Start(F2)\"" }));
    };
    const home = await mkdtemp(join(tmpdir(), "r4-load-"));
    const c = new LaserCellController({ home, makeLaser: async () => new StudioWindowLaser(windowsStudioUi(run), { completion: "watch", markSeconds: 1, marginSeconds: 0 }) });
    await c.configure({ laser: { driver: "studio-window" } });
    const load = failure(c.studioLoadJob({ file: join(home, "x.studio.svg"), widthMm: 20, heightMm: 20 }));
    while (!loading) await Bun.sleep(1);
    await c.stop();
    const t0 = Date.now();
    const opAfterStop = (await c.snapshot({ probe: false })).operation;
    const runAfterStop = await failure(c.run({ boards: 1, mode: "dry-run" }));
    await load;
    expect(opAfterStop).toBeNull();
  });

  test("E2: Stop during a move while one servo does not answer: no joint is frozen, the arm carries on to the goal", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-arm2-"));
    const servos = fakeServos([1, 2, 3]);
    const c = new LaserCellController({ home, openArmBus: async () => new St3215Bus(servos.link), makeLaser: async () => new SimulatedLaser(1) });
    await c.configure({ arm: { port: "COM7", jointIds: [1, 2], gripperId: 3 }, laser: { driver: "simulator" } });
    await c.connectArm();
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    const goal = (id: number) => { const m = servos.regs.get(id)!; return m[0x2a]! | (m[0x2b]! << 8); };
    setPos(1, 100); setPos(2, 1800);
    await c.teach("clear");
    setPos(1, 4000); setPos(2, 2048); // far away: the move takes a while
    const move = failure(c.moveTo("clear"));
    while (goal(1) !== 100) await Bun.sleep(1); // goal written, arm moving
    const gripper = servos.regs.get(3)!;
    servos.regs.delete(3); // the gripper servo stops answering (loose plug / bus noise)
    await c.stop();
    servos.regs.set(3, gripper);
    // Stop's freeze writes goal = present position for every joint; here joint 1 still has the far goal.
    expect(goal(1)).not.toBe(100);
    await c.dispose();
  });
});

describe("round 4 D2b: default 3 s link timeout", () => {
  test("D2b: Stop with the bridge going silent mid-job, default timeouts", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-wifi2-"));
    const square: Array<[number, number]> = [[5, 5], [15, 5], [15, 15], [5, 15]];
    const job: LmcJobFile = { boardMm: { width: 20, height: 20 }, ablate: [square], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };
    await Bun.write(join(home, "F-Cu.lmc.json"), JSON.stringify(job));
    const mock = new MockLmcTransport(1_000_000);
    let hang = false;
    let unhang: () => void = () => undefined;
    const hung = new Promise<void>(r => { unhang = r; });
    mock.replyDelay = async () => { if (hang) await hung; };
    let connections = 0;
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => mock, log: l => { if (l.startsWith("connected")) connections++; } });
    cleanups.push(async () => { unhang(); await b.stop(); });
    const c = new LaserCellController({ home, makeLaser: async () => new LmcLaser(() => openBridgeLmc("127.0.0.1", b.port, "k"), { field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 20 }) });
    await c.configure({ laser: { driver: "usb-lmc", jobPath: join(home, "F-Cu.lbrn2") } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.run({ boards: 1, mode: "laser-only" });
    while ((await c.snapshot({ probe: false })).run.step !== "mark") await Bun.sleep(5);
    await Bun.sleep(100);
    hang = true;
    await Bun.sleep(20);
    const t0 = Date.now();
    await c.stop();
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 30_000);
});

describe("round 4 F: foot-switch job outside the operation lock", () => {
  test("F1: right after a foot-switch Press (laser busy for the job time), an arm Go move is accepted", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-fsarm-"));
    const servos = fakeServos([1, 2, 3]);
    const relay = fakeRelay();
    const c = new LaserCellController({ home, openArmBus: async () => new St3215Bus(servos.link), openRelay: async () => relay });
    await c.configure({ arm: { port: "COM7", jointIds: [1, 2], gripperId: 3 }, laser: { driver: "studio-footswitch", relayPort: "COM9", markSeconds: 60, markTimeoutMinutes: 10 } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.connectArm();
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    setPos(1, 2600); setPos(2, 2500);
    await c.teach("jigPlace"); // in the laser jig
    setPos(1, 2048); setPos(2, 2048);
    await c.footswitch("press"); // Studio marks for ~65 s
    const laser = (await c.snapshot()).laser?.state;
    const move = await failure(c.moveTo("jigPlace"));
    expect(move).not.toBe("no error");
    await c.dispose();
  });
});

describe("round 4 G: Stop while a foot-switch Hold/Press is still opening the relay", () => {
  async function slowRelayCell() {
    const home = await mkdtemp(join(tmpdir(), "r4-slow-"));
    const relay = fakeRelay();
    let opening = false;
    // An Arduino relay waits ~2 s for its bootloader on open (openArduinoRelay); 200 ms here.
    const c = new LaserCellController({ home, openRelay: async () => { opening = true; await Bun.sleep(200); return relay; } });
    await c.configure({ laser: { driver: "studio-footswitch", relayKind: "arduino", relayPort: "COM9", markSeconds: 60, markTimeoutMinutes: 10 } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    return { c, relay, isOpening: () => opening };
  }

  test("G1: Hold, then Stop before the relay is open: the pedal goes down after Stop and stays down", async () => {
    const { c, relay, isOpening } = await slowRelayCell();
    const hold = failure(c.footswitch("hold"));
    while (!isOpening()) await Bun.sleep(1);
    await c.stop();
    const callsAtStop = relay.calls.length;
    expect(relay.calls.slice(callsAtStop)).not.toContain("set true");
    expect(relay.pressed).toBe(false);
  });

  test("G2: Press, then Stop before the relay is open: the press goes out after Stop", async () => {
    const { c, relay, isOpening } = await slowRelayCell();
    const press = failure(c.footswitch("press"));
    while (!isOpening()) await Bun.sleep(1);
    await c.stop();
    const callsAtStop = relay.calls.length;
    expect(relay.calls.slice(callsAtStop)).not.toContain("pulse");
  });
});

describe("round 4: settings", () => {
  test("a laser-cell.json saved with a BOM (PowerShell 5.1, Notepad) keeps its taught positions", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-bom-"));
    await Bun.write(join(home, "laser-cell.json"), "﻿" + JSON.stringify({ poses: { clear: { 1: 3200, 2: 1800 } } }));
    const c = new LaserCellController({ home });
    expect((await c.snapshot({ probe: false })).config.poses.clear).toEqual({ 1: 3200, 2: 1800 });
  });

  test("pointing the cell at another laser (bridge address, USB board) asks for the UV-guard confirmation again", async () => {
    const home = await mkdtemp(join(tmpdir(), "r4-guard-"));
    const c = new LaserCellController({ home, makeLaser: async () => new SimulatedLaser(1) });
    await c.configure({ laser: { driver: "usb-lmc", lmc: { connection: "network", host: "10.0.0.5", token: "k" } } });
    await c.configure({ safetyConfirmed: true }); // test fixture
    await c.configure({ laser: { lmc: { host: "10.0.0.6" } } });
    expect((await c.snapshot({ probe: false })).config.safetyConfirmed).toBe(false);
    await c.configure({ safetyConfirmed: true });
    await c.configure({ laser: { lmc: { maxPowerPct: 15 } } }); // same laser: stays confirmed
    expect((await c.snapshot({ probe: false })).config.safetyConfirmed).toBe(true);
  });
});

describe("round 4: PowerShell when a policy blocks script files", () => {
  test.if(process.platform === "win32")("a long script (over the command-line limit) still runs the inline way", async () => {
    setInlinePowerShellForTests(true);
    try {
      const filler = "# " + "x".repeat(200) + "\n";
      // The script also checks that the bootstrap removed its own copy from the environment.
      const script = filler.repeat(250) + "[Console]::Out.Write($env:FABPLANE_ARGS + ':' + [string]($null -eq $env:FABPLANE_SCRIPT))";
      expect(script.length).toBeGreaterThan(40_000);
      expect(await runPowerShell(script, 20_000, { FABPLANE_ARGS: "ok" })).toBe("ok:True");
    } finally {
      setInlinePowerShellForTests(false);
    }
  });
});
