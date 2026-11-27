import { afterEach, describe, expect, test } from "bun:test";
import { startLmcBridge } from "./bridge";
import { findLasers, hotspotFindings, probeBridge, usbFindings } from "./discover";
import { MockLmcTransport } from "./usb";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!().catch(() => undefined); });

/** What Windows printed on 2026-11-27 with the Omni X switched on (shortened). */
const NETSH = `
Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : ComMarKer_F33DA
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : 40:d6:3c:df:33:da
         Signal             : 0%
         Radio type         : 802.11n
SSID 2 : GuestFleet
    Authentication          : WPA3-Personal
    BSSID 1                 : 42:78:95:1a:5e:8c
         Signal             : 48%
SSID 3 :
    BSSID 1                 : 66:20:e3:78:17:a6
         Signal             : 51%
`;

describe("find laser", () => {
  test("the Omni X's own hotspot is recognised, with its signal and a plain explanation", () => {
    const [h, ...rest] = hotspotFindings(NETSH);
    expect(rest).toHaveLength(0);
    expect(h).toMatchObject({ kind: "hotspot", ssid: "ComMarKer_F33DA", bssid: "40:d6:3c:df:33:da", signalPct: 0 });
    expect(h!.note).toMatch(/ComMarker's app protocol, which fabPlane does not use/);
  });

  test("a USB laser board says whether fabPlane can open it with the driver Windows gave it", () => {
    const [studio, winusb] = usbFindings([
      { vid: 0x9588, pid: 0x9899, path: "a", driver: "lmcv2u", name: "BJJCZ USBLMCV2" },
      { vid: 0x9588, pid: 0x9899, path: "b", driver: "WINUSB", name: "USBLMCV4" },
      { vid: 0x046d, pid: 0xc077, path: "c", driver: "HidUsb", name: "mouse" },
    ]);
    expect(studio).toMatchObject({ vid: "9588", pid: "9899", ready: false });
    expect(studio!.note).toMatch(/needs WinUSB/);
    expect(winusb).toMatchObject({ ready: true });
  });

  test("a fabPlane bridge on the network is found from its hello, without sending the access key", async () => {
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "secret", open: async () => new MockLmcTransport(0) });
    cleanups.push(b.stop);
    const found = await probeBridge("127.0.0.1", b.port);
    expect(found).toMatchObject({ kind: "bridge", host: "127.0.0.1", port: b.port, jobs: true });
    expect(await probeBridge("127.0.0.1", 1, 300)).toBeNull(); // nothing there
  });

  test("one report from all three, and a probe that fails is a note, not an error", async () => {
    const b = await startLmcBridge({ port: 0, hostname: "127.0.0.1", token: "k", open: async () => new MockLmcTransport(0) });
    cleanups.push(b.stop);
    const r = await findLasers({
      port: b.port,
      hosts: ["127.0.0.1"],
      listUsb: async () => { throw new Error("SetupAPI unavailable"); },
      scanWifi: async () => NETSH,
    });
    expect(r.findings.map(f => f.kind).sort()).toEqual(["bridge", "hotspot"]);
    expect(r.notes.join(" ")).toMatch(/USB not checked: SetupAPI unavailable/);
  });
});
