/** Addresses the remote listener can be reached on, for the pairing QR code. */
import { hostname, networkInterfaces } from "node:os";
import type { CoreEndpoint } from "@fabdesk/protocol";

/** Tailscale hands out 100.64.0.0/10 (CGNAT). Those are the addresses worth trying first. */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = [Number(parts[0]), Number(parts[1])];
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Every non-loopback IPv4 address on the machine, tailnet first. IPv6 is left out on purpose:
 * link-local addresses need a zone index that does not survive a QR code.
 */
export function listenAddresses(port: number, interfaces = networkInterfaces()): CoreEndpoint[] {
  const found: CoreEndpoint[] = [];
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== "IPv4") continue;
      found.push({
        host: addr.address,
        port,
        kind: isTailscaleAddress(addr.address) ? "tailscale" : "lan",
        iface,
      });
    }
  }
  return found.sort((a, b) =>
    a.kind === b.kind ? a.host.localeCompare(b.host) : a.kind === "tailscale" ? -1 : 1,
  );
}

export function machineName(): string {
  return hostname().replace(/\.local$/i, "");
}
