/** The macOS / Linux USB transport (libusb), against a fake libusb, so it is checked on any machine. */
import { describe, expect, test } from "bun:test";
import { hotspotFindings, macWifiAsNetsh, usbFindings } from "./discover";
import { LmcLaser } from "./laser";
import { listLibusbDevices, openLibusbLmc, type LibusbApi, type LibusbDevice } from "./libusb";
import { Cmd, command } from "./protocol";
import { LMC_IN_ENDPOINT, LMC_OUT_ENDPOINT, LmcUsbError, MockLmcTransport } from "./usb";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));

/** A fake libusb with one BJJCZ board behind it; the board is MockLmcTransport. */
function fakeLibusb(opts: { stale?: number; claimFails?: boolean; boards?: number } = {}) {
  const board = new MockLmcTransport(0);
  const calls: string[] = [];
  let stale = opts.stale ?? 0;
  const devices: LibusbDevice[] = [
    { vid: 0x05ac, pid: 0x8262, bus: 1, address: 2, ref: "kbd" },
    ...Array.from({ length: opts.boards ?? 1 }, (_, i) => ({ vid: 0x9588, pid: 0x9899, bus: 2, address: 5 + i, ref: `board${i}` })),
  ];
  const lib: LibusbApi = {
    list() { calls.push("list"); return { devices, release: () => calls.push("release-list") }; },
    open(d) { calls.push(`open ${String(d.ref)}`); return `h-${String(d.ref)}`; },
    claim(h) { calls.push(`claim ${String(h)}`); if (opts.claimFails) throw new LmcUsbError("could not claim the laser board (is another program using it?): LIBUSB_ERROR_BUSY"); },
    bulk(_h, ep, data) {
      if (ep === LMC_OUT_ENDPOINT) { void board.write(data); calls.push(`out ${data.length}`); return data.length; }
      if (ep === LMC_IN_ENDPOINT) {
        if (stale > 0) { stale--; data.set([9, 9, 9, 9, 9, 9, 9, 9]); calls.push("in stale"); return 8; }
        // libusb's bulk call is synchronous: take the mock board's pending reply directly.
        const pending = board as unknown as { reply: Uint8Array | null };
        if (pending.reply) { data.set(pending.reply); pending.reply = null; calls.push("in"); return 8; }
        throw new LmcUsbError("USB read: LIBUSB_ERROR_TIMEOUT");
      }
      throw new Error("bad endpoint");
    },
    release(h) { calls.push(`release ${String(h)}`); },
    close(h) { calls.push(`close ${String(h)}`); },
  };
  return { lib, calls, board };
}

describe("libusb transport (macOS)", () => {
  test("the board is listed as ready: macOS has no driver to swap", async () => {
    const { lib } = fakeLibusb();
    const devices = await listLibusbDevices(lib);
    expect(devices).toHaveLength(2);
    const [laser] = usbFindings(devices);
    expect(laser).toMatchObject({ vid: "9588", pid: "9899", driver: "libusb", ready: true });
  });

  test("open claims interface 0, drops stale replies, then a command gets its own answer", async () => {
    const { lib, calls } = fakeLibusb({ stale: 2 });
    const t = await openLibusbLmc(0, 500, lib);
    expect(calls.slice(0, 4)).toEqual(["list", "open board0", "release-list", "claim h-board0"]);
    expect(calls.filter(c => c === "in stale")).toHaveLength(2);
    await t.write(command(Cmd.GetVersion));
    const reply = await t.read();
    expect(reply[0]).toBe(1); // MockLmcTransport's version word, not the stale 9s
    await t.close();
    await t.close(); // twice is fine
    expect(calls.filter(c => c.startsWith("close"))).toHaveLength(1);
    expect(await failure(t.write(command(Cmd.GetVersion)))).toMatch(/closed/);
  });

  test("the second board can be chosen; no board gives a plain message", async () => {
    const two = fakeLibusb({ boards: 2 });
    await openLibusbLmc(1, 500, two.lib);
    expect(two.calls).toContain("open board1");
    const none = fakeLibusb({ boards: 0 });
    expect(await failure(openLibusbLmc(0, 500, none.lib))).toMatch(/no BJJCZ laser board .* plug in the laser's USB cable/);
  });

  test("a board another program holds is closed again and the reason is shown", async () => {
    const { lib, calls } = fakeLibusb({ claimFails: true });
    expect(await failure(openLibusbLmc(0, 500, lib))).toMatch(/LIBUSB_ERROR_BUSY/);
    expect(calls).toContain("close h-board0");
  });

  test("the fabPlane driver runs a read-only probe over it", async () => {
    const { lib } = fakeLibusb();
    const l = new LmcLaser(() => openLibusbLmc(0, 500, lib), { field: { sizeMm: 70, centerMm: [0, 0] }, source: "co2", pins: { laser: 0, light: 8 }, maxPowerPct: 20, initBoard: false, frameSeconds: 1, pollMs: 1 });
    const p = await l.probe();
    expect(p.version[0]).toBe(1);
    await l.close();
  });
});

describe("Wi-Fi scan on macOS", () => {
  const PROFILER = `Wi-Fi:

      Software Versions:
          CoreWLAN: 16.0 (1657)
      Interfaces:
        en0:
          Card Type: Wi-Fi  (0x14E4, 0x4387)
          Status: Connected
          Current Network Information:
            HomeNet:
              PHY Mode: 802.11ax
              Signal / Noise: -52 dBm / -94 dBm
          Other Local Wi-Fi Networks:
            ComMarKer_F33DA:
              PHY Mode: 802.11n
              Channel: 6 (2GHz, 20MHz)
              Network Type: Infrastructure
              Security: WPA2 Personal
              Signal / Noise: -78 dBm / -95 dBm
            Neighbour:
              PHY Mode: 802.11ac
              Signal / Noise: -70 dBm / -95 dBm
        awdl0:
          Status: Off
`;

  test("the Omni X's hotspot is found in system_profiler's list, with its signal", () => {
    const [h, ...rest] = hotspotFindings(macWifiAsNetsh(PROFILER));
    expect(rest).toHaveLength(0);
    expect(h).toMatchObject({ ssid: "ComMarKer_F33DA", signalPct: 44 });
  });

  test("the network the Mac is on is not listed as a laser", () => {
    expect(macWifiAsNetsh(PROFILER)).not.toMatch(/HomeNet/);
  });
});
