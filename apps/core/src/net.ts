/** Addresses the remote listener can be reached on, for the pairing QR code. */
import { hostname, networkInterfaces } from "node:os";
import type { CoreEndpoint, EndpointKind } from "@fabdesk/protocol";
import { orderEndpoints } from "@fabdesk/protocol";

function octets(address: string): [number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  return [Number(parts[0]), Number(parts[1])];
}

/** Tailscale hands out 100.64.0.0/10 (CGNAT). Those are the addresses worth trying first. */
export function isTailscaleAddress(address: string): boolean {
  const o = octets(address);
  return o !== null && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

export function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === "localhost" || lower === "::1" || octets(address)?.[0] === 127;
}

/** RFC 1918 private ranges plus 169.254/16 link-local — what a phone on the same Wi-Fi can reach. */
export function isLanAddress(address: string): boolean {
  const o = octets(address);
  if (!o) return false;
  const [a, b] = o;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function endpointKind(address: string): EndpointKind {
  if (isLoopbackAddress(address)) return "loopback";
  if (isTailscaleAddress(address)) return "tailscale";
  if (isLanAddress(address)) return "lan";
  return "other";
}

/** `0.0.0.0`, `::` and the empty string all mean "every interface". */
export function isWildcardHost(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::" || host === "*";
}

type Address = Omit<CoreEndpoint, "default">;

/**
 * Every address a phone could try for a listener bound to `bindHost`, ordered as the pairing
 * URL should list them. A wildcard bind advertises every non-loopback IPv4 address on the
 * machine; a specific bind advertises only that address — including a loopback one, so the UI
 * can say plainly that no phone will reach it. IPv6 is left out on purpose: link-local
 * addresses need a zone index that does not survive a QR code.
 */
export function listenAddresses(
  port: number,
  opts: {
    bindHost?: string;
    preferred?: EndpointKind | null | undefined;
    interfaces?: ReturnType<typeof networkInterfaces>;
  } = {},
): CoreEndpoint[] {
  const bindHost = opts.bindHost ?? "0.0.0.0";
  const found: Address[] = [];
  for (const [iface, addrs] of Object.entries(opts.interfaces ?? networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== "IPv4") continue;
      found.push({ host: addr.address, port, kind: endpointKind(addr.address), iface });
    }
  }
  let candidates: Address[];
  if (isWildcardHost(bindHost)) candidates = found;
  else if (isLoopbackAddress(bindHost))
    candidates = [
      {
        host: bindHost === "localhost" ? "127.0.0.1" : bindHost,
        port,
        kind: "loopback",
        iface: "lo0",
      },
    ];
  else
    candidates = [
      found.find((a) => a.host === bindHost) ?? {
        host: bindHost,
        port,
        kind: endpointKind(bindHost),
        iface: "",
      },
    ];
  return orderEndpoints(candidates, opts.preferred);
}

export function machineName(): string {
  return hostname().replace(/\.local$/i, "");
}
