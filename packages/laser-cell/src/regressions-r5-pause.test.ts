/** Regression tests from the fifth review (2026-11-27): pause races (USB route and Wi-Fi bridge job mode). Each failed before its fix. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBridgeLmc, startLmcBridge } from "./lmc/bridge";
import { markPackets, type FieldMap, type MarkSettings, type Ring } from "./lmc/job";
import { DEFAULT_TIMING, type LmcJob } from "./lmc/job-file";
import { LmcLaser } from "./lmc/laser";
import { Cmd, List, decodeList } from "./lmc/protocol";
import { MockLmcTransport, type LmcTransport } from "./lmc/usb";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await Promise.resolve(cleanups.pop()!()).catch(() => undefined); });

const sq = (x: number, y: number, a = 1): Ring => [[x, y], [x + a, y], [x + a, y + a], [x, y + a]];
const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 1 };

async function jobFile(job: LmcJob): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "r5-"));
  await writeFile(join(dir, "j.lmc.json"), JSON.stringify(job));
  return join(dir, "j.lmc.json");
}

describe("round 5 pause (USB route)", () => {
  test("V5-P1 pause while the first packet is being readied drops that packet (power/speed settings never reach the board)", async () => {
    const job: LmcJob = { boardMm: { width: 10, height: 10 }, ablate: [sq(0, 0, 10)], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 0.01, angleDeg: 0, angleStepDeg: 0 } };
    const mock = new MockLmcTransport(0);
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile(job));
    let pausedOnce = false;
    // The operator presses Pause while fabPlane is asking the board whether it can take packet 0.
    mock.replyDelay = async op => {
      if (!pausedOnce && op === Cmd.GetVersion && mock.singles.some(c => c.op === Cmd.ResetList)) { pausedOnce = true; void l.pause(); }
    };
    const run = l.start();
    await Bun.sleep(30);
    await l.resume();
    await run;
    await l.waitDone({ timeoutMs: 5_000 });
    const settings: MarkSettings = { ...DEFAULT_TIMING, ...job.settings, powerPct: Math.min(job.settings.powerPct, lmcOptions.maxPowerPct) };
    const field: FieldMap = { ...lmcOptions.field, boardMm: job.boardMm };
    const expected = [...markPackets(job.ablate, field, settings, { source: "co2", pins: lmcOptions.pins })];
    const sentCmds = mock.listCommands();
    expect(mock.lists.length).toBe(expected.length);
    expect(sentCmds.some(c => c.op === List.MarkPowerRatio)).toBe(true);
    expect(decodeList([mock.lists[0]!])[0]!.op).toBe(List.ReadyMark);
  });

  test("V5-P2 pause while ExecuteList is in flight sends no StopList: the board marks while the status says paused", async () => {
    const job: LmcJob = { boardMm: { width: 10, height: 10 }, ablate: [sq(0, 0, 10)], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };
    const mock = new MockLmcTransport(1_000_000); // the board stays busy (marking) for a long time
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile(job));
    let pausing: Promise<void> | null = null;
    mock.replyDelay = async op => { if (op === Cmd.ExecuteList && !pausing) pausing = l.pause(); };
    await l.start();
    await pausing;
    const ops = mock.singles.map(c => c.op);
    const exec = ops.lastIndexOf(Cmd.ExecuteList);
    expect(l.isPaused).toBe(true);
    expect(ops.slice(exec + 1)).toContain(Cmd.StopList); // the running list must be held
    await l.stop();
  });
});

describe("round 5 pause vs stop", () => {
  test("V5-P4 Pause + Resume (another window / the agent) while Stop is halting the board send RestartList after StopExecute", async () => {
    const job: LmcJob = { boardMm: { width: 10, height: 10 }, ablate: [sq(0, 0, 10)], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 0.01, angleDeg: 0, angleStepDeg: 0 } };
    const mock = new MockLmcTransport(1_000_000);
    const l = new LmcLaser(async () => mock, lmcOptions);
    await l.load(await jobFile(job));
    await l.start(); // all packets sent, list executing
    let during: Promise<void> | null = null;
    mock.replyDelay = async op => {
      if (op === Cmd.StopExecute && !during) {
        // Stop is in progress (its StopExecute is on the wire); a Pause and a Resume arrive from elsewhere.
        const a = l.pause().catch(() => undefined), b = l.resume().catch(() => undefined); during = Promise.all([a, b]).then(() => undefined);
        await Bun.sleep(20);
      }
    };
    await l.stop();
    await during;
    const ops = mock.singles.map(c => c.op);
    const after = ops.slice(ops.indexOf(Cmd.StopExecute) + 1);
    expect(after).not.toContain(Cmd.RestartList);
  });
});

describe("round 5 pause (Wi-Fi bridge job mode)", () => {
  test("V5-P3 pause while the job is being handed to the bridge is never sent: the bridge marks the whole job while fabPlane says paused", async () => {
    const mock = new MockLmcTransport(5);
    mock.replyDelay = () => Bun.sleep(1);
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => mock });
    cleanups.push(b.stop);
    const job: LmcJob = { boardMm: { width: 30, height: 30 }, ablate: [sq(0, 0, 30)], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 0.05, angleDeg: 0, angleStepDeg: 0 } };
    let l: LmcLaser;
    // The operator presses Pause while the J request (the job, a few kB to MB over Wi-Fi) is in flight.
    const wrap = (t: LmcTransport): LmcTransport => ({
      remote: true, jobs: t.jobs === true, get closed() { return t.closed === true; },
      rpc: async (type, body) => {
        const r = await t.rpc!(type, body);
        if (type === "J") await l.pause();
        return r;
      },
      write: p => t.write(p), read: () => t.read(), ...(t.transact ? { transact: (p: Uint8Array) => t.transact!(p) } : {}), close: () => t.close(),
    });
    l = new LmcLaser(async () => wrap(await openBridgeLmc("127.0.0.1", b.port, "k")), { ...lmcOptions, pollMs: 50 });
    cleanups.push(() => l.close());
    await l.load(await jobFile(job));
    await l.start();
    const outcome = await Promise.race([l.waitDone({ timeoutMs: 20_000 }).then(() => "finished while paused", e => `error ${e}`), Bun.sleep(6000).then(() => "held")]);
    expect(outcome).toBe("held");
    expect(mock.lists.length).toBeLessThan(3); // held on the bridge before the board could mark
    await l.stop();
  }, 30_000);
});
