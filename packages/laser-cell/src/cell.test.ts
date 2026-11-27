import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Arm, DEFAULT_ARM_CONFIG } from "./arm";
import { CellError, runCycle, type CellPoses } from "./cell";
import { LaserCellController } from "./controller";
import { LightBurnLaser, SimulatedLaser, StudioFootswitchLaser, lcusRelayCommand, type UdpTransport } from "./lasers";
import { parseWindowsSerialComm, windowsDcb, windowsTimeouts } from "./serial";
import { St3215Bus } from "./st3215";
import { fakeServos } from "./st3215.test";

const POSES: CellPoses = {
  home: { 1: 2048, 2: 2048 },
  stackAbove: { 1: 1500, 2: 2200 },
  stackPick: { 1: 1500, 2: 2500 },
  jigAbove: { 1: 2600, 2: 2200 },
  jigPlace: { 1: 2600, 2: 2500 },
  clear: { 1: 3200, 2: 1800 },
  trayAbove: { 1: 900, 2: 2200 },
  trayPlace: { 1: 900, 2: 2500 },
  gripperOpen: 2400,
  gripperClosed: 1600,
};

function cellArm(options: Parameters<typeof fakeServos>[1] = {}) {
  const servos = fakeServos([1, 2, 3], options);
  return { arm: new Arm(new St3215Bus(servos.link), { ...DEFAULT_ARM_CONFIG, jointIds: [1, 2], gripperId: 3, moveTimeoutMs: 2000 }), servos };
}

describe("relay and serial helpers", () => {
  test("LCUS relay frames", () => {
    expect(Array.from(lcusRelayCommand(1, true))).toEqual([0xa0, 0x01, 0x01, 0xa2]);
    expect(Array.from(lcusRelayCommand(1, false))).toEqual([0xa0, 0x01, 0x00, 0xa1]);
  });

  test("Windows SERIALCOMM listing", () => {
    const out = "\r\nHKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM\r\n    \\Device\\wchusbser1    REG_SZ    COM12\r\n    \\Device\\Serial0    REG_SZ    COM1\r\n";
    expect(parseWindowsSerialComm(out)).toEqual([
      { path: "COM1", label: "COM1 · Serial0" },
      { path: "COM12", label: "COM12 · CH34x USB serial" },
    ]);
  });

  test("DCB and timeouts layout", () => {
    const dcb = new DataView(windowsDcb(1_000_000).buffer);
    expect(dcb.getUint32(0, true)).toBe(28);
    expect(dcb.getUint32(4, true)).toBe(1_000_000);
    expect(dcb.getUint8(18)).toBe(8);
    expect(new DataView(windowsTimeouts(40).buffer).getUint32(8, true)).toBe(40);
  });
});

describe("LightBurn UDP driver", () => {
  function fakeLightBurn(script: (cmd: string) => string | null) {
    const sent: string[] = [];
    let pending: string | null = null;
    const udp: UdpTransport = {
      async send(text) { sent.push(text); pending = script(text); },
      async receive() { const r = pending; pending = null; return r; },
      close() {},
    };
    return { udp, sent };
  }

  test("reports idle, busy and offline", async () => {
    let busy = false;
    const { udp } = fakeLightBurn(cmd => (cmd === "PING" ? "OK" : cmd === "STATUS" ? (busy ? "!" : "OK") : "OK"));
    const laser = new LightBurnLaser(udp);
    expect((await laser.status()).state).toBe("idle");
    busy = true;
    expect((await laser.status()).state).toBe("busy");
    const silent = new LightBurnLaser(fakeLightBurn(() => null).udp);
    expect((await silent.status()).state).toBe("offline");
  });

  test("waits for busy then idle before reporting done", async () => {
    const statuses = ["!", "!", "!", "OK", "OK"];
    const { udp, sent } = fakeLightBurn(cmd => (cmd === "STATUS" ? statuses.shift() ?? "OK" : "OK"));
    const laser = new LightBurnLaser(udp, { pollMs: 1 });
    await laser.load("C:\\jobs\\board.lbrn2");
    await laser.start();
    await laser.waitDone({ timeoutMs: 5000 });
    expect(sent.slice(0, 2)).toEqual(["FORCELOAD:C:\\jobs\\board.lbrn2", "START"]);
    expect(statuses).toEqual([]);
  });

  test("a START that never runs is an error, not a finished board", async () => {
    const { udp } = fakeLightBurn(() => "OK");
    const laser = new LightBurnLaser(udp, { pollMs: 1, startTimeoutMs: 20 });
    await expect(laser.waitDone({ timeoutMs: 5000 })).rejects.toThrow("never reported the job as running");
  });
});

describe("Studio foot-switch driver", () => {
  test("pulses the relay and waits the job time", async () => {
    const pulses: number[] = [];
    const laser = new StudioFootswitchLaser({ relay: { pressed: false, set: async () => {}, pulse: async ms => { pulses.push(ms); }, close: async () => {} }, markSeconds: 0.05, marginSeconds: 0 });
    await laser.start();
    expect((await laser.status()).state).toBe("busy");
    const t = Date.now();
    await laser.waitDone({ timeoutMs: 10_000 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(40);
    expect(pulses).toEqual([250]);
    expect((await laser.status()).state).toBe("idle");
  });
});

describe("runCycle", () => {
  test("pick → place → clear → mark → unload, and the laser only fires once the arm is clear", async () => {
    const { arm } = cellArm({ blocked: { 3: 1900 } });
    const laser = new SimulatedLaser(20);
    const steps: string[] = [];
    let armAtStart: number | null = null;
    const start = laser.start.bind(laser);
    laser.start = async () => { armAtStart = await arm.bus.position(1); await start(); };
    await runCycle(arm, laser, POSES, { frameSeconds: 0, markTimeoutMs: 5000, onEvent: e => { if (e.type === "step") steps.push(e.step); } });
    expect(steps).toEqual(["preflight", "pick", "place", "clear", "mark", "unload", "done"]);
    expect(armAtStart).not.toBeNull();
    expect(Math.abs(armAtStart! - POSES.clear![1]!)).toBeLessThanOrEqual(DEFAULT_ARM_CONFIG.toleranceSteps);
    expect(laser.log).toEqual(["start", "done"]);
  });

  test("an empty gripper stops the cycle before the laser fires", async () => {
    const { arm } = cellArm();
    const laser = new SimulatedLaser(20);
    await expect(runCycle(arm, laser, POSES, { frameSeconds: 0, markTimeoutMs: 5000 })).rejects.toThrow("No board in the gripper");
    expect(laser.log).toEqual(["stop"]);
  });

  test("missing poses are reported by name", async () => {
    const { arm } = cellArm();
    const err = await runCycle(arm, new SimulatedLaser(), { home: { 1: 1 } }, { frameSeconds: 0, markTimeoutMs: 1000 }).catch(e => e);
    expect(err).toBeInstanceOf(CellError);
    expect(err.message).toContain("Clear of laser");
  });

  test("stop aborts and stops the laser", async () => {
    const { arm } = cellArm({ blocked: { 3: 1900 } });
    const laser = new SimulatedLaser(10_000);
    const controller = new AbortController();
    const run = runCycle(arm, laser, POSES, { frameSeconds: 0, markTimeoutMs: 60_000, signal: controller.signal, onEvent: e => { if (e.type === "step" && e.step === "mark") setTimeout(() => controller.abort(), 20); } });
    await expect(run).rejects.toThrow("Stopped");
    expect(laser.log.at(-1)).toBe("stop");
  });
});

describe("LaserCellController", () => {
  async function controller() {
    const home = await mkdtemp(join(tmpdir(), "laser-cell-"));
    const servos = fakeServos([1, 2, 3], { blocked: { 3: 1900 } });
    const c = new LaserCellController({
      home,
      listPorts: async () => [{ path: "COM7", label: "COM7 · CH34x USB serial" }],
      openArmBus: async () => new St3215Bus(servos.link),
      makeLaser: async () => new SimulatedLaser(10),
    });
    await c.configure({ arm: { port: "COM7", jointIds: [1, 2], gripperId: 3 }, laser: { driver: "simulator" } });
    return { c, home, servos };
  }

  test("teaches poses, persists them and refuses an automatic run without the safety confirmation", async () => {
    const { c, home, servos } = await controller();
    await c.connectArm();
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    for (const [name, pose] of Object.entries(POSES)) {
      if (typeof pose === "number") { setPos(3, pose); await c.teach(name as "gripperOpen"); continue; }
      for (const [id, pos] of Object.entries(pose!)) setPos(Number(id), pos);
      await c.teach(name as "home");
    }
    const saved = JSON.parse(await readFile(join(home, "laser-cell.json"), "utf8"));
    expect(saved.poses.clear).toEqual({ 1: 3200, 2: 1800 });
    expect(saved.poses.gripperClosed).toBe(1600);
    await expect(c.run({ boards: 1, mode: "cycle" })).rejects.toThrow("UV safety guard");
    await c.configure({ safetyConfirmed: true });
    await c.run({ boards: 2, mode: "cycle" });
    await c.settled();
    const snap = await c.snapshot();
    expect(snap.run.error).toBeNull();
    expect(snap.run.done).toBe(2);
    expect(snap.missing).toEqual([]);
  });

  test("a dry run needs no confirmation and never touches the laser", async () => {
    const { c, servos } = await controller();
    await c.connectArm();
    const setPos = (id: number, pos: number) => { const m = servos.regs.get(id)!; m[0x38] = pos & 0xff; m[0x39] = pos >> 8; };
    for (const [name, pose] of Object.entries(POSES)) {
      if (typeof pose === "number") { setPos(3, pose); await c.teach(name as "gripperOpen"); continue; }
      for (const [id, pos] of Object.entries(pose!)) setPos(Number(id), pos);
      await c.teach(name as "home");
    }
    await c.run({ boards: 1, mode: "dry-run" });
    await c.settled();
    expect((await c.snapshot({ probe: false })).run).toMatchObject({ done: 1, error: null });
  });
});
