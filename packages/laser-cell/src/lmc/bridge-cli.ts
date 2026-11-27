#!/usr/bin/env bun
/**
 * fabPlane laser bridge: run this on the computer whose USB port the laser is plugged into
 * (Windows with the WinUSB driver, or Linux / Raspberry Pi), then choose "Wi-Fi bridge" in fabPlane.
 *
 *   bun packages/laser-cell/src/lmc/bridge-cli.ts [--port 5021] [--mock]
 *
 * On first start it creates an access key in ~/.fabplane-laser-bridge.json; type it into fabPlane.
 * --mock answers like a laser board without one attached (for testing the Wi-Fi link).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { BRIDGE_DEFAULT_PORT, newBridgeToken, startLmcBridge } from "./bridge";
import { MockLmcTransport, openUsbLmc } from "./usb";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(value("port") ?? BRIDGE_DEFAULT_PORT);
const configPath = join(homedir(), ".fabplane-laser-bridge.json");
let token = value("token");
if (!token) {
  const saved = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as { token?: string }).token : undefined;
  token = saved ?? newBridgeToken();
  if (!saved) writeFileSync(configPath, JSON.stringify({ token }, null, 2), { mode: 0o600 });
}
const mock = flag("mock");
const bridge = await startLmcBridge({
  port,
  token,
  open: async () => (mock ? new MockLmcTransport() : openUsbLmc()),
  log: line => console.log(`${new Date().toLocaleTimeString()}  ${line}`),
});
const ips = Object.values(networkInterfaces()).flat().filter(n => n && n.family === "IPv4" && !n.internal).map(n => n!.address);
console.log(`fabPlane laser bridge${mock ? " (MOCK, no laser)" : ""} listening on port ${bridge.port}`);
console.log(`In fabPlane: Laser Controller → Settings → fabPlane USB driver → Connect via: Wi-Fi bridge`);
console.log(`  Address: ${ips.join(" or ") || "this computer's IP address"}   Port: ${bridge.port}   Access key: ${token}`);
console.log("Keep this window open. Ctrl+C stops the bridge.");
process.on("SIGINT", async () => { await bridge.stop(); process.exit(0); });
