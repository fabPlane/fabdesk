/** The Wi-Fi bridge over real TCP on this machine, with a mock laser board behind it. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, frame, openBridgeLmc, startLmcBridge } from "./bridge";
import { LmcLaser, type LmcJobFile } from "./laser";
import { Cmd, List } from "./protocol";
import { MockLmcTransport } from "./usb";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function bridge(mock = new MockLmcTransport(3)) {
  const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "secret-key", open: async () => mock });
  stops.push(b.stop);
  return { port: b.port, mock };
}

/** Awaits a promise's error (bun hangs on expect(p).rejects once p has rejected). */
const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));

describe("laser bridge", () => {
  test("frames survive being split across TCP chunks", () => {
    const r = new FrameReader();
    const bytes = new Uint8Array([...frame("W", new Uint8Array(12).fill(7)), ...frame("R")]);
    expect(r.push(bytes.slice(0, 7))).toEqual([]);
    const out = r.push(bytes.slice(7));
    expect(out.map(f => [f.type, f.payload.length])).toEqual([["W", 12], ["R", 0]]);
  });

  test("a wrong access key is refused", async () => {
    const { port } = await bridge();
    expect(await failure(openBridgeLmc("127.0.0.1", port, "wrong"))).toMatch(/wrong access key/);
  });

  test("a second computer cannot take over a laser in use", async () => {
    const { port } = await bridge();
    const first = await openBridgeLmc("127.0.0.1", port, "secret-key");
    stops.push(() => first.close());
    expect(await failure(openBridgeLmc("127.0.0.1", port, "secret-key"))).toMatch(/already driving/);
  });

  test("no bridge running gives a clear message", async () => {
    expect(await failure(openBridgeLmc("127.0.0.1", 1, "secret-key", 500))).toMatch(/could not reach the laser bridge|did not answer|closed/);
  });

  test("a whole job runs over the bridge: probe, mark, wait, stop", async () => {
    const { port, mock } = await bridge(new MockLmcTransport(4));
    const laser = new LmcLaser(() => openBridgeLmc("127.0.0.1", port, "secret-key"), {
      field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: true, frameSeconds: 1, pollMs: 1,
    });
    stops.push(() => laser.close());
    const dir = await mkdtemp(join(tmpdir(), "lmc-bridge-"));
    const job: LmcJobFile = { boardMm: { width: 20, height: 20 }, ablate: [[[5, 5], [15, 5], [15, 15], [5, 15]]], settings: { powerPct: 80, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 } };
    await writeFile(join(dir, "job.lmc.json"), JSON.stringify(job));
    await laser.load(join(dir, "job.lmc.json"));
    const probe = await laser.probe();
    expect(probe.version.slice(0, 3)).toEqual([1, 2, 3]);
    await laser.start();
    await laser.waitDone({ timeoutMs: 5000 });
    expect(mock.listCommands().filter(c => c.op === List.MarkTo)).toHaveLength(10);
    expect(mock.listCommands().find(c => c.op === List.MarkPowerRatio)!.params[0]).toBe(Math.round((200 * 20) / 40));
    await laser.stop();
    expect(mock.singles.map(c => c.op)).toContain(Cmd.StopExecute);
  });
});
