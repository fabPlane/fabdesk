import { describe, expect, test } from "bun:test";
import { StudioFootswitchLaser, arduinoRelayCommand, openArduinoRelay, openLcusRelay } from "./lasers";
import type { SerialLink } from "./st3215";

function fakePort(answer: (bytes: Uint8Array) => number[] = () => []) {
  const written: number[][] = [];
  let inbox: number[] = [];
  let closed = false;
  const link: SerialLink = {
    async write(bytes) { written.push(Array.from(bytes)); inbox.push(...answer(bytes)); },
    async read() { const out = new Uint8Array(inbox); inbox = []; return out; },
    async flushInput() { inbox = []; },
    async close() { closed = true; },
  };
  return { link, written, isClosed: () => closed };
}

describe("foot-switch relays", () => {
  test("LCUS relay starts released, presses and releases", async () => {
    const port = fakePort();
    const relay = await openLcusRelay("COM9", 1, async () => port.link);
    expect(port.written).toEqual([[0xa0, 1, 0, 0xa1]]);
    await relay.set(true);
    expect(relay.pressed).toBe(true);
    await relay.pulse(1);
    expect(relay.pressed).toBe(false);
    expect(port.written.slice(-2)).toEqual([[0xa0, 1, 1, 0xa2], [0xa0, 1, 0, 0xa1]]);
    await relay.close();
    expect(port.isClosed()).toBe(true);
  });

  test("Arduino relay pings the sketch, then speaks '1' / '0'", async () => {
    const port = fakePort(bytes => (bytes[0] === 0x3f ? [0x4b] : []));
    const relay = await openArduinoRelay("COM4", async () => port.link, 0);
    await relay.pulse(1);
    expect(port.written).toEqual([[0x3f], [0x30], [0x31], [0x30]]);
    expect(Array.from(arduinoRelayCommand(true))).toEqual([0x31]);
  });

  test("a port without the sketch is refused and closed", async () => {
    const port = fakePort();
    await expect(openArduinoRelay("COM4", async () => port.link, 0)).rejects.toThrow("no answer from the foot-switch sketch");
    expect(port.isClosed()).toBe(true);
  });

  test("a held pedal makes the laser busy so a run cannot start, and stop releases it", async () => {
    const port = fakePort();
    const relay = await openLcusRelay("COM9", 1, async () => port.link);
    const laser = new StudioFootswitchLaser({ relay, markSeconds: 1, marginSeconds: 0 });
    await relay.set(true);
    expect((await laser.status()).state).toBe("busy");
    await laser.stop();
    expect(relay.pressed).toBe(false);
    expect((await laser.status()).state).toBe("idle");
  });
});
