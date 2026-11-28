/** Marking features of fabPlane's own driver: travel order, drawing lines, edge passes, placement, pause. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMarkJob, markPackets, orderPaths, type FieldMap, type MarkSettings, type Ring, type Vec } from "./job";
import type { LmcJob } from "./job-file";
import { LmcLaser } from "./laser";
import { Cmd, List, decodeList } from "./protocol";
import { MockLmcTransport } from "./usb";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));
const s: MarkSettings = { powerPct: 10, speedMmPerS: 500, travelMmPerS: 2000, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0, laserOnDelayUs: 100, laserOffDelayUs: 100, polygonDelayUs: 100, jumpDelayUs: 200 };
const field: FieldMap = { sizeMm: 70, centerMm: [0, 0], boardMm: { width: 40, height: 40 } };
const sq = (x: number, y: number, a = 1): Ring => [[x, y], [x + a, y], [x + a, y + a], [x, y + a]];
const opts = { source: "co2" as const, pins: { laser: 0, light: 8 } };

const travel = (paths: Ring[], closed: boolean) => {
  let pen: Vec | null = null, t = 0;
  for (const p of paths) {
    if (pen) t += Math.hypot(p[0]![0] - pen[0], p[0]![1] - pen[1]);
    pen = closed ? p[0]! : p.at(-1)!;
  }
  return t;
};

describe("travel order", () => {
  test("hundreds of pads in random order: the outline pass jumps a fraction of the distance", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pads = Array.from({ length: 400 }, () => sq(rnd() * 38, rnd() * 38));
    const ordered = orderPaths(pads, true, null);
    expect(ordered).toHaveLength(400);
    expect(travel(ordered, true)).toBeLessThan(travel(pads, true) / 5);
  });

  test("a ring starts at the vertex nearest the pen; an open line is drawn from its nearer end", () => {
    expect(orderPaths([sq(10, 10, 5)], true, [16, 16])[0]![0]).toEqual([15, 15]);
    expect(orderPaths([[[0, 0], [10, 0]]], false, [11, 0])[0]![0]).toEqual([10, 0]);
  });
});

describe("job contents", () => {
  test("drawing lines are marked, never filled", () => {
    const cmds = decodeList([...markPackets([], field, { ...s, intervalMm: 0 }, { ...opts, lines: [[[0, 0], [10, 0], [10, 10]]] })]);
    expect(cmds.filter(c => c.op === List.MarkTo)).toHaveLength(2);
  });

  test("edge passes run after the fill with their own speed", () => {
    const edge = { passes: 2, settings: { ...s, speedMmPerS: 100 } };
    const cmds = decodeList([...markPackets([sq(0, 0, 10)], field, s, { ...opts, edge })]);
    const speeds = cmds.filter(c => c.op === List.MarkSpeed).map(c => c.params[0]);
    expect(speeds).toHaveLength(2);
    expect(speeds[1]!).toBeLessThan(speeds[0]!);
    const afterEdgeSpeed = cmds.slice(cmds.findIndex((c, i) => c.op === List.MarkSpeed && i > 10));
    expect(afterEdgeSpeed.filter(c => c.op === List.MarkTo)).toHaveLength(8); // 2 passes × 4 sides
  });

  test("the time estimate no longer adds a phantom 23 s jump per pass", () => {
    expect(buildMarkJob([sq(0, 0, 10)], field, { ...s, passes: 3 }, opts).estimatedSeconds).toBeLessThan(1);
  });
});

async function jobFile(job: LmcJob): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "marking-"));
  await writeFile(join(dir, "j.lmc.json"), JSON.stringify(job));
  return join(dir, "j.lmc.json");
}

const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 100, initBoard: false, frameSeconds: 1, pollMs: 1 };
const base: LmcJob = { boardMm: { width: 10, height: 10 }, ablate: [sq(0, 0, 10)], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 0.05, angleDeg: 0, angleStepDeg: 0 } };

describe("placement", () => {
  test("a job's own position moves it on the lens", async () => {
    const firstJump = async (job: LmcJob) => {
      const mock = new MockLmcTransport(0);
      const l = new LmcLaser(async () => mock, lmcOptions);
      await l.load(await jobFile(job));
      await l.start();
      return mock.listCommands().find(c => c.op === List.JumpTo)!.params[0]!;
    };
    const centred = await firstJump(base);
    const moved = await firstJump({ ...base, positionMm: { x: 10, y: 0 } });
    expect(moved - centred).toBe(Math.round(10 * (0xffff / 70)));
  });
});

describe("pause and resume", () => {
  test("pause holds the list (StopList) and sends nothing more; resume restarts it; progress says paused", async () => {
    const mock = new MockLmcTransport(1_000_000);
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile({ ...base, settings: { ...base.settings, intervalMm: 0.002 } })); // many packets
    mock.replyDelay = () => Bun.sleep(1); // a real board takes time; lets the test act between packets
    let packets = 0;
    const write = mock.write.bind(mock);
    mock.write = async p => { if (p.length === 0xc00) packets++; return write(p); };
    const run = l.start();
    while (packets < 5) await Bun.sleep(1);
    await l.pause();
    expect(mock.singles.map(c => c.op)).toContain(Cmd.StopList);
    expect(l.progress()?.paused).toBe(true);
    const held = packets;
    await Bun.sleep(60);
    expect(packets).toBe(held);
    await l.resume();
    expect(mock.singles.map(c => c.op)).toContain(Cmd.RestartList);
    await run;
    expect(packets).toBeGreaterThan(held);
    await l.stop();
  });

  test("a paused job is never taken as finished, and Stop still works while paused", async () => {
    const mock = new MockLmcTransport(1_000_000); // marking
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile(base));
    await l.start();
    await l.pause();
    // While held, the board reports idle (its list is stopped): that must not count as finished.
    const read = mock.read.bind(mock);
    mock.read = async () => { const r = await read(); new DataView(r.buffer).setUint16(6, 0x20, true); return r; };
    const done = failure(l.waitDone({ timeoutMs: 100 }));
    await Bun.sleep(150); // longer than the time limit: paused time does not count
    await l.stop();
    expect(await done).toMatch(/stopped/);
    expect(l.progress()).toBeNull();
  });

  test("pause when the board has already finished the whole job is refused (a later RestartList could run it again)", async () => {
    const mock = new MockLmcTransport(0);
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile(base));
    await l.start();
    expect(await failure(l.pause())).toMatch(/finishing/);
    expect(l.isPaused).toBe(false);
    await l.stop();
  });

  test("pause with nothing being marked is refused", async () => {
    const l = new LmcLaser(async () => new MockLmcTransport(0), lmcOptions);
    expect(await failure(l.pause())).toMatch(/nothing is being marked/);
  });
});
