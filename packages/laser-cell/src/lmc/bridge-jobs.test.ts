/** Job mode of the Wi-Fi bridge: the bridge runs the job itself, so Wi-Fi hiccups never starve the board. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { frame, openBridgeLmc, startLmcBridge } from "./bridge";
import type { LmcJob } from "./job-file";
import { LmcLaser } from "./laser";
import { Cmd } from "./protocol";
import { MockLmcTransport, type LmcTransport } from "./usb";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await Promise.resolve(cleanups.pop()!()).catch(() => undefined); });

const sq = (a: number): Array<[number, number]> => [[0, 0], [a, 0], [a, a], [0, a]];
const job = (intervalMm: number): LmcJob => ({ boardMm: { width: 30, height: 30 }, ablate: [sq(30)], settings: { powerPct: 10, speedMmPerS: 500, frequencyKhz: 40, passes: 1, intervalMm, angleDeg: 0, angleStepDeg: 0 } });
const lmcOptions = { field: { sizeMm: 70, centerMm: [0, 0] as [number, number] }, source: "co2" as const, pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 20 };

async function jobFile(j: LmcJob): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-jobs-"));
  await writeFile(join(dir, "j.lmc.json"), JSON.stringify(j));
  return join(dir, "j.lmc.json");
}

async function bridge(mock: MockLmcTransport) {
  const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => mock });
  cleanups.push(b.stop);
  return b.port;
}

/** Counts what fabPlane sends over the network; `raw` hides the bridge's job mode (an older bridge). */
function counting(t: LmcTransport, counts: { requests: number }, raw = false): LmcTransport {
  return {
    remote: true,
    get closed() { return t.closed === true; },
    jobs: raw ? false : t.jobs === true,
    ...(t.rpc && !raw ? { rpc: (type: "J" | "Q" | "S" | "U" | "V", body?: unknown) => { counts.requests++; return t.rpc!(type, body); } } : {}),
    write: p => { counts.requests++; return t.write(p); },
    read: () => { counts.requests++; return t.read(); },
    ...(t.transact ? { transact: (p: Uint8Array) => { counts.requests++; return t.transact!(p); } } : {}),
    close: () => t.close(),
  };
}

/** A TCP relay between fabPlane and the bridge that can hold all traffic (a Wi-Fi hiccup). */
async function relay(target: number) {
  let holding = false;
  const held: Array<() => void> = [];
  const pass = (fn: () => void) => (holding ? held.push(fn) : fn());
  const server = Bun.listen<{ up: Socket<undefined> | null; early: Uint8Array[] }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        client.data = { up: null, early: [] };
        const up = await Bun.connect({ hostname: "127.0.0.1", port: target, socket: {
          data(_u, chunk) { const copy = new Uint8Array(chunk); pass(() => client.write(copy)); },
          close() { client.end(); },
        } });
        client.data.up = up;
        for (const c of client.data.early) up.write(c);
      },
      data(client, chunk) {
        const copy = new Uint8Array(chunk);
        pass(() => (client.data.up ? client.data.up.write(copy) : client.data.early.push(copy)));
      },
      close(client) { client.data.up?.end(); },
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port, hold(on: boolean) { holding = on; if (!on) held.splice(0).forEach(f => f()); } };
}

describe("bridge job mode", () => {
  test("the whole job crosses the network once: a handful of requests for dozens of list packets", async () => {
    const mock = new MockLmcTransport(3);
    const port = await bridge(mock);
    const counts = { requests: 0 };
    const l = new LmcLaser(async () => counting(await openBridgeLmc("127.0.0.1", port, "k"), counts), lmcOptions);
    cleanups.push(() => l.close());
    await l.load(await jobFile(job(0.01)));
    await l.start();
    await l.waitDone({ timeoutMs: 30_000 });
    expect(mock.lists.length).toBeGreaterThan(20);
    expect(counts.requests).toBeLessThan(mock.lists.length / 2);
  });

  test("a Wi-Fi hiccup of 1.5 s does not starve the board: it keeps marking and the job finishes", async () => {
    const mock = new MockLmcTransport(3);
    mock.replyDelay = () => Bun.sleep(4); // a board that takes its time: the job lasts a few seconds
    const port = await bridge(mock);
    const net = await relay(port);
    const l = new LmcLaser(() => openBridgeLmc("127.0.0.1", net.port, "k"), lmcOptions);
    cleanups.push(() => l.close());
    await l.load(await jobFile(job(0.004)));
    await l.start();
    while (mock.lists.length < 5) await Bun.sleep(5);
    net.hold(true);
    const before = mock.lists.length;
    await Bun.sleep(1500);
    const during = mock.lists.length - before;
    net.hold(false);
    await l.waitDone({ timeoutMs: 60_000 });
    expect(during).toBeGreaterThan(10); // fed over the bridge's own USB while the Wi-Fi was silent
  }, 30_000);

  test("pause and resume reach the board through the bridge; Stop halts the bridge's job", async () => {
    const mock = new MockLmcTransport(1_000_000);
    mock.replyDelay = () => Bun.sleep(1);
    const port = await bridge(mock);
    const l = new LmcLaser(() => openBridgeLmc("127.0.0.1", port, "k"), lmcOptions);
    cleanups.push(() => l.close());
    await l.load(await jobFile(job(0.004)));
    await l.start();
    while (mock.lists.length < 4) await Bun.sleep(2);
    await l.pause();
    for (let i = 0; i < 100 && !mock.singles.some(c => c.op === Cmd.StopList); i++) await Bun.sleep(5);
    expect(mock.singles.map(c => c.op)).toContain(Cmd.StopList);
    await l.resume();
    expect(mock.singles.map(c => c.op)).toContain(Cmd.RestartList);
    const done = failure(l.waitDone({ timeoutMs: 60_000 }));
    await Bun.sleep(50);
    await l.stop();
    expect(await done).toMatch(/stopped/);
    expect(mock.singles.map(c => c.op)).toContain(Cmd.StopExecute);
  }, 30_000);

  test("an older bridge without job mode is still driven packet by packet", async () => {
    const mock = new MockLmcTransport(3);
    const port = await bridge(mock);
    const counts = { requests: 0 };
    const l = new LmcLaser(async () => counting(await openBridgeLmc("127.0.0.1", port, "k"), counts, true), lmcOptions);
    cleanups.push(() => l.close());
    await l.load(await jobFile(job(0.05)));
    await l.start();
    await l.waitDone({ timeoutMs: 30_000 });
    expect(mock.lists.length).toBeGreaterThan(2);
    expect(counts.requests).toBeGreaterThan(mock.lists.length);
  });

  test("a red-light frame runs on the bridge too", async () => {
    const mock = new MockLmcTransport(2);
    const port = await bridge(mock);
    const l = new LmcLaser(() => openBridgeLmc("127.0.0.1", port, "k"), lmcOptions);
    cleanups.push(() => l.close());
    await l.load(await jobFile(job(0.05)));
    await l.frame(0.2);
    expect(mock.lists.length).toBeGreaterThan(0);
  });

  test("before the access key, the bridge refuses a huge frame instead of buffering it", async () => {
    const port = await bridge(new MockLmcTransport(0));
    let closed = false;
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, close() { closed = true; } } });
    const header = frame("A", new Uint8Array(0));
    new DataView(header.buffer).setUint32(1, 50 * 1024 * 1024, true); // claims 50 MB
    s.write(header);
    for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(5);
    expect(closed).toBe(true);
  });
});
