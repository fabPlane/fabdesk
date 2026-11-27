import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLightFrame, buildMarkJob, hatch, toGalvo, type FieldMap, type MarkSettings, type Shape } from "./job";
import { LmcLaser, type LmcJobFile } from "./laser";
import { Cmd, LIST_COMMANDS_PER_PACKET, List, ListPackets, command, decodeList, parseReply } from "./protocol";
import { MockLmcTransport, parseUsbPath } from "./usb";

const square = (x: number, y: number, s: number) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] as Array<[number, number]>;
const field: FieldMap = { sizeMm: 70, centerMm: [0, 0], boardMm: { width: 20, height: 20 } };
const settings: MarkSettings = { powerPct: 80, speedMmPerS: 500, travelMmPerS: 2000, frequencyKhz: 40, passes: 2, intervalMm: 1, angleDeg: 0, angleStepDeg: 90, laserOnDelayUs: 100, laserOffDelayUs: 100, polygonDelayUs: 100, jumpDelayUs: 200 };

describe("LMC protocol", () => {
  test("a command is six little-endian words", () => {
    expect([...command(Cmd.GotoXY, 0x8000, 0x1234)]).toEqual([0x0d, 0x00, 0x00, 0x80, 0x34, 0x12, 0, 0, 0, 0, 0, 0]);
    expect(() => command(Cmd.GotoXY, 70000)).toThrow(RangeError);
  });

  test("lists pack 256 commands per 3072-byte packet, padded with end-of-list", () => {
    const list = new ListPackets();
    for (let i = 0; i < 300; i++) list.add(List.JumpTo, i, i);
    const packets = list.finish();
    expect(packets).toHaveLength(2);
    expect(packets.every(p => p.length === 0xc00)).toBe(true);
    const cmds = decodeList(packets);
    expect(cmds[0]).toEqual({ op: List.JumpTo, params: [0, 0, 0, 0, 0] });
    expect(cmds[300]!.op).toBe(List.EndOfList);
    expect(cmds.at(-1)!.op).toBe(List.EndOfList);
    expect(LIST_COMMANDS_PER_PACKET).toBe(256);
  });

  test("replies carry the status in the fourth word", () => {
    expect(parseReply(new Uint8Array([1, 0, 2, 0, 3, 0, 0x24, 0])).status).toBe(0x24);
  });

  test("USB paths give vendor and product", () => {
    expect(parseUsbPath("\\\\?\\usb#vid_9588&pid_9899#5&abc#{a5dcbf10-6530-11d2-901f-00c04fb951ed}")).toEqual({ vid: 0x9588, pid: 0x9899 });
  });
});

describe("job geometry", () => {
  test("hatch fills a square with serpentine lines", () => {
    const segs = hatch([square(0, 0, 10)], 1, 0);
    expect(segs).toHaveLength(10);
    expect(segs[0]![0][0]).toBeCloseTo(0);
    expect(segs[0]![1][0]).toBeCloseTo(10);
    expect(segs[1]![0][0]).toBeCloseTo(10); // second line runs back
  });

  test("holes are left out (even-odd)", () => {
    const segs = hatch([square(0, 0, 10), square(3, 3, 4)], 1, 0);
    const total = segs.reduce((n, [p, q]) => n + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
    expect(total).toBeCloseTo(100 - 16, 0);
  });

  test("a 90° hatch covers the same area", () => {
    const len = (a: number) => hatch([square(0, 0, 10)], 0.5, a).reduce((n, [p, q]) => n + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
    expect(len(90)).toBeCloseTo(len(0), 1);
  });

  test("board centre lands on the field centre; outside the field is refused", () => {
    expect(toGalvo(field, [10, 10])).toEqual([0x8000, 0x8000]);
    const [x] = toGalvo(field, [20, 10]);
    expect(x - 0x8000).toBe(Math.round((10 * 0xffff) / 70));
    expect(() => toGalvo({ ...field, centerMm: [30, 0] }, [20, 10])).toThrow(/outside the 70 mm lens field/);
  });

  test("the mark list sets speed and power, marks every hatch line, and switches the laser pin off at the end", () => {
    const job = buildMarkJob([square(5, 5, 10)], field, settings, { source: "co2", pins: { laser: 0, light: 8 } });
    const cmds = decodeList(job.packets);
    expect(cmds[0]!.op).toBe(List.ReadyMark);
    expect(cmds[1]).toEqual({ op: List.WritePort, params: [1, 0, 0, 0, 0] });
    expect(cmds.some(c => c.op === List.MarkPowerRatio)).toBe(true);
    expect(cmds.filter(c => c.op === List.MarkTo)).toHaveLength(40); // 10 lines × 2 directions (cross-hatch) × 2 passes
    const lastPort = cmds.filter(c => c.op === List.WritePort).at(-1)!;
    expect(lastPort.params[0]).toBe(0);
    expect(job.estimatedSeconds).toBeGreaterThan(0);
  });

  test("the light frame never marks and drives only the light pin", () => {
    const job = buildLightFrame([square(5, 5, 10)], field, { pins: { laser: 0, light: 8 }, travelMmPerS: 1000, loops: 3 });
    const cmds = decodeList(job.packets);
    expect(cmds.some(c => c.op === List.MarkTo)).toBe(false);
    expect(cmds.filter(c => c.op === List.WritePort).map(c => c.params[0])).toEqual([1 << 8, 0]);
  });
});

describe("USB laser driver (mock board)", () => {
  async function laser(busyReads = 3, maxPowerPct = 100) {
    const mock = new MockLmcTransport(busyReads);
    const l = new LmcLaser(async () => mock, { field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct, initBoard: true, frameSeconds: 1, pollMs: 1 });
    const dir = await mkdtemp(join(tmpdir(), "lmc-"));
    const job: LmcJobFile = { boardMm: { width: 20, height: 20 }, ablate: [square(5, 5, 10)], settings: { powerPct: 80, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };
    await writeFile(join(dir, "job.lmc.json"), JSON.stringify(job));
    await l.load(join(dir, "job.lmc.json"));
    return { l, mock };
  }

  test("connect reads serial and version, then initialises the board", async () => {
    const { l, mock } = await laser();
    const p = await l.probe();
    expect(p.version.slice(0, 3)).toEqual([1, 2, 3]);
    expect(mock.singles.slice(0, 3).map(c => c.op)).toEqual([Cmd.GetSerialNo, Cmd.GetVersion, Cmd.Reset]);
  });

  test("start sends the list and executes it; waitDone returns when the board is idle", async () => {
    const { l, mock } = await laser(5);
    await l.start();
    expect(mock.singles.some(c => c.op === Cmd.ExecuteList)).toBe(true);
    expect((await l.status()).state).toBe("busy");
    await l.waitDone({ timeoutMs: 5000 });
    expect((await l.status()).state).toBe("idle");
    expect(mock.listCommands().filter(c => c.op === List.MarkTo)).toHaveLength(10);
  });

  test("the power cap overrides the job", async () => {
    const { l, mock } = await laser(1, 10);
    await l.start();
    await l.waitDone({ timeoutMs: 5000 });
    const ratio = mock.listCommands().find(c => c.op === List.MarkPowerRatio)!.params[0];
    expect(ratio).toBe(Math.round((200 * 10) / 40));
  });

  test("stop halts the board and switches outputs off", async () => {
    const { l, mock } = await laser(1_000_000);
    await l.start();
    await l.stop();
    const ops = mock.singles.map(c => c.op);
    expect(ops).toContain(Cmd.StopExecute);
    expect(mock.singles.filter(c => c.op === Cmd.WritePort).at(-1)!.params[0]).toBe(0);
    expect((await l.status()).state).toBe("idle");
  });

  test("frame traces the red light only", async () => {
    const { l, mock } = await laser(2);
    await l.frame(0.2);
    expect(mock.listCommands().some(c => c.op === List.MarkTo)).toBe(false);
  });
});

describe("USB route through the controller", () => {
  test("a laser-only run marks the exported job; preview needs the UV-guard confirmation", async () => {
    const { LaserCellController } = await import("../controller");
    const dir = await mkdtemp(join(tmpdir(), "lmc-cell-"));
    const job: LmcJobFile = { boardMm: { width: 20, height: 20 }, ablate: [square(5, 5, 10)], settings: { powerPct: 80, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };
    await writeFile(join(dir, "F-Cu-laser-isolation.lmc.json"), JSON.stringify(job));
    const mock = new MockLmcTransport(3);
    const c = new LaserCellController({
      home: dir,
      makeLaser: async () => new LmcLaser(async () => mock, { field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 1 }),
    });
    await c.configure({ laser: { driver: "usb-lmc", jobPath: join(dir, "F-Cu-laser-isolation.lbrn2") } });
    await expect(c.preview(1)).rejects.toThrow(/UV guard/);
    // Test fixture only: on the machine, the person at the cell confirms the guard.
    await c.configure({ safetyConfirmed: true });
    await c.run({ boards: 1, mode: "laser-only" });
    await c.settled();
    expect((await c.snapshot({ probe: false })).run).toMatchObject({ done: 1, error: null });
    expect(mock.listCommands().filter(x => x.op === List.MarkTo)).toHaveLength(10);
  });
});

test("stop while a long job is still being sent stops feeding the board", async () => {
  // A slow USB link, so the job is still streaming when Stop arrives.
  class SlowMock extends MockLmcTransport {
    override async write(packet: Uint8Array) { if (packet.length === 0xc00) await Bun.sleep(2); return super.write(packet); }
  }
  const mock = new SlowMock(1_000_000);
  const l = new LmcLaser(async () => mock, { field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 1 });
  const dir = await mkdtemp(join(tmpdir(), "lmc-stop-"));
  const job: LmcJobFile = { boardMm: { width: 40, height: 40 }, ablate: [square(0, 0, 40)], settings: { powerPct: 50, speedMmPerS: 500, frequencyKhz: 40, passes: 4, intervalMm: 0.05, angleDeg: 0, angleStepDeg: 90 } };
  await writeFile(join(dir, "big.lmc.json"), JSON.stringify(job));
  await l.load(join(dir, "big.lmc.json"));
  // Await the outcome directly: bun hangs on expect(promise).rejects once the promise has already rejected.
  const run = l.start().then(() => null, (e: unknown) => e);
  await Bun.sleep(40);
  await l.stop();
  expect(String(await run)).toMatch(/stopped/);
  const sent = mock.lists.length;
  await Bun.sleep(30);
  expect(mock.lists.length).toBe(sent); // nothing more after the stop
  expect(sent).toBeLessThan(20);
  expect(mock.singles.map(c => c.op)).toContain(Cmd.StopExecute);
});

test("the streamed mark list is byte-identical to the whole list, and checks the field before the first packet", async () => {
  const { markPackets, buildMarkJob } = await import("./job");
  const shape: Shape = [square(2, 2, 16), square(6, 6, 4), [[3, 15], [9, 17], [5, 12]]];
  const s: MarkSettings = { ...settings, passes: 3, intervalMm: 0.07, angleDeg: 15, angleStepDeg: 90 };
  const opts = { source: "fiber" as const, pins: { laser: 0, light: 8 } };
  const streamed = [...markPackets(shape, field, s, opts)];
  const whole = buildMarkJob(shape, field, s, opts).packets;
  expect(streamed.length).toBe(whole.length);
  expect(streamed.every((p, i) => p.every((b, k) => b === whole[i]![k]))).toBe(true);
  // Checked when the list is made, before any packet exists.
  expect(() => markPackets(shape, { ...field, centerMm: [40, 0] }, s, opts)).toThrow(/outside the 70 mm lens field/);
});
