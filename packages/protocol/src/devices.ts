/** Paired mobile clients and the QR pairing handshake (see docs/mobile.md). */
import { z } from "zod/v4";

export const DevicePlatform = z.enum(["ios", "android", "web", "other"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const Device = z.object({
  id: z.string(),
  label: z.string(),
  platform: DevicePlatform,
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

/** One address the daemon's remote listener can be reached on. Tailnet addresses come first. */
export const CoreEndpoint = z.object({
  host: z.string(),
  port: z.number().int(),
  /** `tailscale` for 100.64.0.0/10, `lan` otherwise. */
  kind: z.enum(["tailscale", "lan"]),
  iface: z.string(),
});
export type CoreEndpoint = z.infer<typeof CoreEndpoint>;

export const PairStartResult = z.object({
  /** The one-time secret the phone exchanges for a device token. Also the QR payload's `t`. */
  pairingToken: z.string(),
  /** Human-typeable fallback for the same pairing attempt. */
  code: z.string(),
  expiresAt: z.string(),
  endpoints: z.array(CoreEndpoint),
  /** The full `fabdesk://pair?…` URL the desktop renders as a QR code. */
  url: z.string(),
  coreName: z.string(),
});
export type PairStartResult = z.infer<typeof PairStartResult>;

export const PairClaim = z.object({
  pairingToken: z.string().min(1),
  label: z.string().min(1).max(80),
  platform: DevicePlatform.default("other"),
});
export type PairClaim = z.infer<typeof PairClaim>;

export const PairClaimResult = z.object({
  deviceToken: z.string(),
  device: Device,
  core: z.object({ name: z.string(), version: z.string(), platform: z.string() }),
});
export type PairClaimResult = z.infer<typeof PairClaimResult>;

export const PAIRING_URL_SCHEME = "fabdesk";
export const PAIRING_URL_PREFIX = `${PAIRING_URL_SCHEME}://pair`;

export interface PairingPayload {
  version: 1;
  /** One-time pairing secret, good for a few minutes. */
  token: string;
  /** Every address the daemon believes it is reachable on; the phone tries them in order. */
  hosts: string[];
  port: number;
  /** Hostname of the machine, shown while connecting. */
  name: string;
}

/** The QR payload. Hosts repeat as `h=` so the phone can fall back from tailnet to LAN. */
export function buildPairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams();
  params.set("v", String(payload.version));
  params.set("t", payload.token);
  params.set("p", String(payload.port));
  params.set("n", payload.name);
  const hosts = payload.hosts.map((h) => `h=${encodeURIComponent(h)}`).join("&");
  return `${PAIRING_URL_PREFIX}?${params.toString()}${hosts ? `&${hosts}` : ""}`;
}

export function pairingUrlFromEndpoints(opts: {
  token: string;
  endpoints: CoreEndpoint[];
  port: number;
  name: string;
}): string {
  return buildPairingUrl({
    version: 1,
    token: opts.token,
    hosts: opts.endpoints.map((e) => e.host),
    port: opts.port,
    name: opts.name,
  });
}

export function parsePairingUrl(raw: string): PairingPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(`${PAIRING_URL_PREFIX}?`)) return null;
  const params = new URLSearchParams(trimmed.slice(PAIRING_URL_PREFIX.length + 1));
  const token = params.get("t");
  const port = Number(params.get("p"));
  const hosts = params.getAll("h").filter(Boolean);
  if (!token || !Number.isFinite(port) || port <= 0 || hosts.length === 0) return null;
  return { version: 1, token, hosts, port, name: params.get("n") ?? "fabPlane" };
}

/** Base URLs to try, in the order the daemon listed them (tailnet first). IPv6 gets bracketed. */
export function candidateBaseUrls(payload: Pick<PairingPayload, "hosts" | "port">): string[] {
  return payload.hosts.map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${payload.port}`);
}
