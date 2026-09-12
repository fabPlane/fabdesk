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

/**
 * How a phone would reach an address. `tailscale` is 100.64.0.0/10, `lan` a private or link-local
 * range, `loopback` 127/8 (only ever advertised when the listener is bound to it — a phone cannot
 * use it), `other` anything else (a public address, or a hostname).
 */
export const EndpointKind = z.enum(["tailscale", "lan", "other", "loopback"]);
export type EndpointKind = z.infer<typeof EndpointKind>;

/** Preference when the user has not picked a kind. Loopback is never first while anything else exists. */
export const ENDPOINT_KIND_ORDER: readonly EndpointKind[] = [
  "tailscale",
  "lan",
  "other",
  "loopback",
];

/** One address the daemon's remote listener can be reached on. */
export const CoreEndpoint = z.object({
  host: z.string(),
  port: z.number().int(),
  kind: EndpointKind,
  iface: z.string(),
  /** The one the pairing URL lists first; exactly one endpoint carries it when any exist. */
  default: z.boolean(),
});
export type CoreEndpoint = z.infer<typeof CoreEndpoint>;

/**
 * Sorts endpoints into the order the phone should try them and flags the first as the default:
 * the preferred kind (if any endpoint has it), then `ENDPOINT_KIND_ORDER`, hosts alphabetical
 * within a kind. Loopback stays last whatever the preference — it never works from a phone.
 */
export function orderEndpoints<E extends Omit<CoreEndpoint, "default">>(
  endpoints: readonly E[],
  preferred: EndpointKind | null | undefined,
): Array<E & { default: boolean }> {
  const rank = (e: E) =>
    e.kind !== "loopback" && e.kind === preferred ? -1 : ENDPOINT_KIND_ORDER.indexOf(e.kind);
  const sorted = [...endpoints].sort((a, b) => rank(a) - rank(b) || a.host.localeCompare(b.host));
  return sorted.map((e, i) => ({ ...e, default: i === 0 }));
}

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
  /**
   * The kind of each host, parallel to `hosts`. Absent on links from daemons that predate it
   * (and on links whose `k=` list did not line up with `h=`), so treat it as a hint only.
   */
  kinds?: EndpointKind[];
}

/**
 * The QR payload: `fabdesk://pair?v=1&t=<token>&p=<port>&n=<name>&h=<host>…&k=<kind>…`.
 *
 * Hosts repeat as `h=` so the phone can fall back from tailnet to LAN. Kinds travel as a parallel
 * `k=` list, one per host in the same order, rather than inside `h=`: phones built before `k=`
 * existed ignore the parameter and keep parsing `h=` exactly as they always did, and a daemon
 * without kinds simply omits the list. A kind this parser does not know becomes `other`, so a
 * newer daemon can add kinds without breaking an older phone that does know `k=`.
 */
export function buildPairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams();
  params.set("v", String(payload.version));
  params.set("t", payload.token);
  params.set("p", String(payload.port));
  params.set("n", payload.name);
  const hosts = payload.hosts.map((h) => `h=${encodeURIComponent(h)}`);
  const kinds =
    payload.kinds && payload.kinds.length === payload.hosts.length
      ? payload.kinds.map((k) => `k=${encodeURIComponent(k)}`)
      : [];
  return [`${PAIRING_URL_PREFIX}?${params.toString()}`, ...hosts, ...kinds].join("&");
}

/** Builds the URL from ordered endpoints: the `default` one (or, failing that, the first) goes first. */
export function pairingUrlFromEndpoints(opts: {
  token: string;
  endpoints: CoreEndpoint[];
  port: number;
  name: string;
}): string {
  const ordered = [...opts.endpoints].sort((a, b) => Number(b.default) - Number(a.default));
  return buildPairingUrl({
    version: 1,
    token: opts.token,
    hosts: ordered.map((e) => e.host),
    kinds: ordered.map((e) => e.kind),
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
  const rawKinds = params.getAll("k");
  const kinds =
    rawKinds.length === hosts.length
      ? rawKinds.map((k) => (EndpointKind.safeParse(k).success ? (k as EndpointKind) : "other"))
      : null;
  return {
    version: 1,
    token,
    hosts,
    port,
    name: params.get("n") ?? "fabPlane",
    ...(kinds ? { kinds } : {}),
  };
}

/** Base URLs to try, in the order the daemon listed them (tailnet first). IPv6 gets bracketed. */
export function candidateBaseUrls(payload: Pick<PairingPayload, "hosts" | "port">): string[] {
  return payload.hosts.map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${payload.port}`);
}
