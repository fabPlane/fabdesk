/**
 * "Find laser": every way fabPlane can see a laser from this computer, read-only (nothing is sent to a laser).
 *
 * - USB: a BJJCZ galvo board (9588:9899, the Omni X's controller, as LightBurn drives it) and the Windows
 *   driver bound to it. fabPlane's driver needs WinUSB; ComMarker / EZCAD install their own.
 * - Wi-Fi hotspot: an Omni X broadcasts "ComMarker_XXXX". That link speaks ComMarker's app protocol, which
 *   fabPlane does not use; it only tells the laser is on and near.
 * - fabPlane laser bridges on this computer's networks (TCP 5021): a computer cabled to the laser.
 */
import { networkInterfaces } from "node:os";
import { BRIDGE_DEFAULT_PORT, FrameReader } from "./bridge";
import { LMC_PID, LMC_VID, listUsbDevices, type UsbDeviceInfo } from "./usb";

export type UsbLaser = { kind: "usb"; vid: string; pid: string; driver: string | null; name: string | null; ready: boolean; note: string };
export type HotspotLaser = { kind: "hotspot"; ssid: string; bssid: string | null; signalPct: number | null; note: string };
export type BridgeLaser = { kind: "bridge"; host: string; port: number; version: number; jobs: boolean; note: string };
export type LaserFinding = UsbLaser | HotspotLaser | BridgeLaser;

export type FindLasersOptions = {
  usb?: boolean;
  wifi?: boolean;
  lan?: boolean;
  port?: number;
  /** Tests: replace the probes. */
  listUsb?: () => Promise<UsbDeviceInfo[]>;
  scanWifi?: () => Promise<string>;
  hosts?: string[];
};

const hex = (n: number) => n.toString(16).padStart(4, "0");

/** USB laser boards, with whether fabPlane's driver can open them as they are. */
export function usbFindings(devices: UsbDeviceInfo[]): UsbLaser[] {
  return devices.filter(d => d.vid === LMC_VID && d.pid === LMC_PID).map(d => {
    const driver = d.driver ?? null;
    const ready = !!driver && /^winusb$/i.test(driver);
    const note = ready
      ? "Laser board on USB with the WinUSB driver: fabPlane's USB driver can talk to it."
      : driver
        ? `Laser board on USB, but Windows gives it the "${driver}" driver (ComMarker / EZCAD). fabPlane needs WinUSB: install it for this device with Zadig (zadig.akeo.ie), then Find laser again. ComMarker Studio cannot use the USB cable until its driver is put back.`
        : "Laser board on USB without a driver. Install WinUSB for it with Zadig (zadig.akeo.ie), then Find laser again.";
    return { kind: "usb" as const, vid: hex(d.vid), pid: hex(d.pid), driver, name: d.name ?? null, ready, note };
  });
}

/** Parses `netsh wlan show networks mode=bssid` (labels may be translated; the layout is the same). */
export function hotspotFindings(netsh: string): HotspotLaser[] {
  const out: HotspotLaser[] = [];
  let current: HotspotLaser | null = null;
  for (const raw of netsh.split(/\r?\n/)) {
    const line = raw.trim();
    const ssid = /^SSID\s+\d+\s*:\s*(.*)$/i.exec(line);
    if (ssid) {
      current = /^commarker/i.test(ssid[1]!.trim())
        ? { kind: "hotspot", ssid: ssid[1]!.trim(), bssid: null, signalPct: null, note: "" }
        : null;
      if (current) out.push(current);
      continue;
    }
    if (!current) continue;
    const bssid = /^BSSID\s+\d+\s*:\s*([0-9a-f:]{17})/i.exec(line);
    if (bssid && !current.bssid) current.bssid = bssid[1]!.toLowerCase();
    const signal = /:\s*(\d{1,3})\s*%\s*$/.exec(line);
    if (signal && current.signalPct === null) current.signalPct = Number(signal[1]);
  }
  for (const h of out) {
    h.note = `The laser's own Wi-Fi (${h.ssid}) is on${h.signalPct !== null ? ` (signal ${h.signalPct} %)` : ""}. That link speaks ComMarker's app protocol, which fabPlane does not use: for fabPlane, connect the laser's USB cable to this computer, or to a small computer running the fabPlane laser bridge.`;
  }
  return out;
}

/** Windows: asks the Wi-Fi adapter for a fresh scan, then lists the networks it sees. */
async function scanWindowsWifi(): Promise<string> {
  const { runPowerShell } = await import("../studio-window");
  const script = String.raw`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class FabWScan {
  [DllImport("wlanapi.dll")] static extern int WlanOpenHandle(uint v, IntPtr r, out uint nv, out IntPtr h);
  [DllImport("wlanapi.dll")] static extern int WlanEnumInterfaces(IntPtr h, IntPtr r, out IntPtr list);
  [DllImport("wlanapi.dll")] static extern int WlanScan(IntPtr h, ref Guid g, IntPtr ssid, IntPtr ie, IntPtr r);
  [DllImport("wlanapi.dll")] static extern int WlanCloseHandle(IntPtr h, IntPtr r);
  public static int Scan() {
    uint nv; IntPtr h; if (WlanOpenHandle(2, IntPtr.Zero, out nv, out h) != 0) return 0;
    IntPtr list; if (WlanEnumInterfaces(h, IntPtr.Zero, out list) != 0) { WlanCloseHandle(h, IntPtr.Zero); return 0; }
    int n = Marshal.ReadInt32(list); int done = 0;
    for (int i = 0; i < n; i++) { Guid g = (Guid)Marshal.PtrToStructure(new IntPtr(list.ToInt64() + 8 + i * 532), typeof(Guid)); if (WlanScan(h, ref g, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero) == 0) done++; }
    WlanCloseHandle(h, IntPtr.Zero); return done;
  }
}
'@
if ([FabWScan]::Scan() -gt 0) { Start-Sleep -Seconds 4 }
[Console]::Out.Write((netsh wlan show networks mode=bssid | Out-String))
`;
  return runPowerShell(script, 20_000);
}

/** Private IPv4 /24 networks of this computer (and localhost), to look for bridges on. */
export function lanHosts(): string[] {
  const hosts = new Set<string>(["127.0.0.1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue; // home / office networks only
      const base = a.address.split(".").slice(0, 3).join(".");
      for (let i = 1; i < 255; i++) if (`${base}.${i}` !== a.address) hosts.add(`${base}.${i}`);
    }
  }
  return [...hosts];
}

/** Connects, reads the bridge's hello (no access key is sent), closes. */
export async function probeBridge(host: string, port: number, timeoutMs = 500): Promise<BridgeLaser | null> {
  return new Promise(resolve => {
    let done = false;
    let sock: { end(): void } | null = null;
    const finish = (r: BridgeLaser | null) => { if (done) return; done = true; clearTimeout(timer); sock?.end(); resolve(r); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const reader = new FrameReader(4096);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) { sock = s; if (done) s.end(); },
        data(_s, chunk) {
          let frames;
          try { frames = reader.push(new Uint8Array(chunk)); } catch { finish(null); return; }
          const hello = frames[0];
          if (!hello) return;
          try {
            const info = JSON.parse(new TextDecoder().decode(hello.payload)) as { bridge?: unknown; version?: unknown; jobs?: unknown };
            if (hello.type !== "H" || info.bridge !== "fabplane-lmc") { finish(null); return; }
            finish({ kind: "bridge", host, port, version: Number(info.version) || 0, jobs: info.jobs === true, note: `fabPlane laser bridge at ${host}:${port}${info.jobs === true ? "" : " (older version: update it for job mode)"}. Enter this address and the bridge's access key in Settings → Connect via Wi-Fi.` });
          } catch {
            finish(null);
          }
        },
        close() { finish(null); },
        error() { finish(null); },
      },
    }).catch(() => finish(null));
  });
}

async function findBridges(hosts: string[], port: number): Promise<BridgeLaser[]> {
  const found: BridgeLaser[] = [];
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++]!;
      const b = await probeBridge(host, port);
      if (b) found.push(b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, hosts.length) }, worker));
  return found;
}

/** Everything that can be found; a probe that fails is reported in `notes`, never as an error. */
export async function findLasers(options: FindLasersOptions = {}): Promise<{ findings: LaserFinding[]; notes: string[] }> {
  const notes: string[] = [];
  const port = options.port ?? BRIDGE_DEFAULT_PORT;
  const usb = options.usb === false ? Promise.resolve([]) : (options.listUsb ?? listUsbDevices)().then(usbFindings, (e: unknown) => { notes.push(`USB not checked: ${e instanceof Error ? e.message : String(e)}`); return []; });
  const wifi = options.wifi === false
    ? Promise.resolve([])
    : (options.scanWifi ?? (process.platform === "win32" ? scanWindowsWifi : async () => ""))().then(hotspotFindings, (e: unknown) => { notes.push(`Wi-Fi not checked: ${e instanceof Error ? e.message : String(e)}`); return []; });
  const lan = options.lan === false ? Promise.resolve([]) : findBridges(options.hosts ?? lanHosts(), port);
  const [u, w, l] = await Promise.all([usb, wifi, lan]);
  return { findings: [...u, ...l, ...w], notes };
}
