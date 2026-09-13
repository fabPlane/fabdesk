/** Paired mobile clients and the QR pairing handshake (see docs/mobile.md). */
import { z } from "zod/v4";

export const DevicePlatform = z.enum(["ios", "android", "web", "other"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** The path a device's request took: the daemon's own listener, or the relay (`apps/relay`). */
export const DeviceVia = z.enum(["direct", "relay"]);
export type DeviceVia = z.infer<typeof DeviceVia>;

export const Device = z.object({
  id: z.string(),
  label: z.string(),
  platform: DevicePlatform,
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  /** How the device last authenticated; null until it has, absent from older daemons. */
  via: DeviceVia.nullable().optional(),
});
export type Device = z.infer<typeof Device>;

/* ---------- push registration (docs/mobile-notifications.md §4.1) ---------- */

/** An APNs device token: 64 hex characters (the phone gets it from `getDevicePushTokenAsync`). */
export const APNS_TOKEN_RE = /^[0-9a-fA-F]{64}$/;
/** An FCM registration token: long, URL-safe, with one colon (`<id>:APA91b…`). */
export const FCM_TOKEN_RE = /^[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{40,}$/;

/**
 * Which service the token belongs to. fabplane.com routes on it and talks to Apple / Google
 * directly with the credentials it holds; there is no Expo hop.
 */
export const PushTokenKind = z.enum(["apns", "fcm"]);
export type PushTokenKind = z.infer<typeof PushTokenKind>;

/** Classifies a token by shape, or null when it is neither. */
export function pushTokenKindOf(token: string): PushTokenKind | null {
  if (APNS_TOKEN_RE.test(token)) return "apns";
  if (FCM_TOKEN_RE.test(token)) return "fcm";
  return null;
}

export const DevicePushPrefs = z.object({
  /** `agent.done` with status `completed`. */
  onDone: z.boolean().default(true),
  /** `agent.done` with status `failed` or `aborted`, and `agent.error`. */
  onFailed: z.boolean().default(true),
  /** `agent.approval_requested` / `agent.input_requested` (supervised runs). */
  onNeedsInput: z.boolean().default(true),
  /** `job.done` for long jobs (`route_run`, `render_*`). */
  onJobs: z.boolean().default(false),
});
export type DevicePushPrefs = z.infer<typeof DevicePushPrefs>;

/** `PUT /v1/devices/me/push` body. Sent on every connect (the token can rotate) and on prefs change. */
export const DevicePushRegistration = z
  .object({
    /** The native token from `getDevicePushTokenAsync`: APNs on iOS, FCM on Android. */
    pushToken: z.string().min(1),
    /** Which service `pushToken` belongs to; inferred from its shape when absent. */
    tokenKind: PushTokenKind.optional(),
    platform: DevicePlatform,
    appVersion: z.string().optional(),
    prefs: DevicePushPrefs.default({
      onDone: true,
      onFailed: true,
      onNeedsInput: true,
      onJobs: false,
    }),
  })
  .transform((r, ctx) => {
    const kind = r.tokenKind ?? pushTokenKindOf(r.pushToken);
    if (!kind) {
      ctx.addIssue({ code: "custom", message: "pushToken must be an APNs or FCM token" });
      return z.NEVER;
    }
    return {
      pushToken: r.pushToken,
      tokenKind: kind,
      platform: r.platform,
      appVersion: r.appVersion,
      prefs: r.prefs,
    };
  });
export type DevicePushRegistration = z.output<typeof DevicePushRegistration>;
/** What a client sends; the schema fills in `tokenKind` from the token's shape when omitted. */
export type DevicePushRegistrationInput = z.input<typeof DevicePushRegistration>;

/** What a device sees of its own registration; the token itself is never echoed back. */
export const DevicePushState = z.object({
  registeredAt: z.string(),
  platform: DevicePlatform,
  tokenKind: PushTokenKind,
  prefs: DevicePushPrefs,
});
export type DevicePushState = z.infer<typeof DevicePushState>;

/** `GET /v1/devices/me`: the caller's own device, plus its push registration if any. */
export const DeviceMe = Device.extend({ push: DevicePushState.nullable() });
export type DeviceMe = z.infer<typeof DeviceMe>;

/** `PUT /v1/devices/me/push` response. */
export const DevicePushResult = z.object({
  device: Device,
  push: z.object({ registeredAt: z.string() }),
});
export type DevicePushResult = z.infer<typeof DevicePushResult>;

/**
 * What the daemon hands fabplane.com (`POST /v1/private/push`, §4.2), which forwards it to Expo
 * unchanged. `data` is all the phone reads; `title`/`body` are display only.
 */
export const PushKind = z.enum(["run.done", "run.failed", "run.needs_input", "job.done"]);
export type PushKind = z.infer<typeof PushKind>;

export const PushData = z.object({
  v: z.literal(1),
  kind: PushKind,
  /** Daemon identity (§4.4), so a phone paired with two computers can tell them apart. */
  coreId: z.string(),
  coreName: z.string(),
  threadId: z.string().optional(),
  runId: z.string().optional(),
  jobId: z.string().optional(),
  projectId: z.string().optional(),
});
export type PushData = z.infer<typeof PushData>;

export const PushMessage = z.object({
  /** The device's APNs or FCM token. */
  to: z.string().min(1),
  /** Which provider `to` belongs to, so fabplane.com need not guess from the shape. */
  tokenKind: PushTokenKind,
  title: z.string().max(80),
  body: z.string().max(200),
  data: PushData,
  sound: z.enum(["default"]).optional(),
  badge: z.number().int().optional(),
  /** Android channel; `runs` by default. */
  channelId: z.string().optional(),
  ttl: z.number().int().min(0).max(86_400).optional(),
  priority: z.enum(["default", "normal", "high"]).optional(),
  /** iOS action category; `run` for now (no actions until the relay lands). */
  categoryId: z.string().optional(),
});
export type PushMessage = z.infer<typeof PushMessage>;

export const PUSH_BATCH_MAX = 20;
export const PushRequest = z.object({ messages: z.array(PushMessage).min(1).max(PUSH_BATCH_MAX) });
export type PushRequest = z.infer<typeof PushRequest>;

export const PushTicket = z.union([
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string() }).optional(),
  }),
]);
export type PushTicket = z.infer<typeof PushTicket>;
/**
 * Same order as the request's `messages`. Since fabplane.com's durable queue, `200` means
 * "queued": every ticket is `ok` with the job id, and `queued` says when the batch expires.
 */
export const PushResponse = z.object({
  tickets: z.array(PushTicket),
  queued: z.object({ jobId: z.string(), expiresAt: z.string() }).optional(),
});
export type PushResponse = z.infer<typeof PushResponse>;

/** `GET /v1/private/push/:jobId` — the worker's verdict per message, by request index. */
export const PushJobStatus = z.enum(["queued", "running", "completed", "failed", "expired"]);
export const PushOutcome = z.object({
  index: z.number().int().min(0),
  provider: z.string().optional(),
  outcome: z.enum(["accepted", "device_not_registered", "rejected", "expired"]),
  id: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});
export const PushJob = z.object({
  jobId: z.string(),
  status: PushJobStatus,
  outcomes: z.array(PushOutcome).default([]),
});
export type PushJob = z.infer<typeof PushJob>;

/**
 * How a phone would reach an address. `tailscale` is 100.64.0.0/10, `lan` a private or link-local
 * range, `loopback` 127/8 (only ever advertised when the listener is bound to it — a phone cannot
 * use it), `other` anything else (a public address, or a hostname). `tailscale-https` is the
 * machine's MagicDNS name fronted by `tailscale serve` on 443: the tailnet terminates TLS with a
 * certificate the phone already trusts, so it is the one kind that needs no ATS exception.
 */
export const EndpointKind = z.enum([
  "tailscale-https",
  "tailscale",
  "lan",
  "other",
  "loopback",
  "relay",
]);
export type EndpointKind = z.infer<typeof EndpointKind>;

export const EndpointScheme = z.enum(["http", "https"]);
export type EndpointScheme = z.infer<typeof EndpointScheme>;

/** Preference when the user has not picked a kind. Loopback is never first while anything else exists. */
export const ENDPOINT_KIND_ORDER: readonly EndpointKind[] = [
  "tailscale-https",
  "tailscale",
  "lan",
  "other",
  "loopback",
  // A relay is never a direct listener; it sits last and only matters when nothing else answers.
  "relay",
];

/** One address the daemon's remote listener can be reached on. */
export const CoreEndpoint = z.object({
  /** What goes into the pairing URL's `h=`: an IP, or a DNS name for `tailscale-https`. */
  host: z.string(),
  port: z.number().int(),
  kind: EndpointKind,
  iface: z.string(),
  /** The one the pairing URL lists first; exactly one endpoint carries it when any exist. */
  default: z.boolean(),
  /** `http` when absent; daemons from before `tailscale-https` never send it. */
  scheme: EndpointScheme.optional(),
  /** A DNS name for `host` (MagicDNS), when one is known. Shown instead of the bare IP. */
  hostname: z.string().optional(),
});
export type CoreEndpoint = z.infer<typeof CoreEndpoint>;

export function endpointScheme(e: Pick<CoreEndpoint, "scheme">): EndpointScheme {
  return e.scheme ?? "http";
}

/** `https://name` for an https endpoint on 443, otherwise `scheme://host:port`. IPv6 gets bracketed. */
export function endpointBaseUrl(e: Pick<CoreEndpoint, "host" | "port" | "scheme">): string {
  const scheme = endpointScheme(e);
  const host = e.host.includes(":") ? `[${e.host}]` : e.host;
  return scheme === "https" && e.port === 443 ? `https://${host}` : `${scheme}://${host}:${e.port}`;
}

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

/**
 * What the daemon learned from the Tailscale CLI (`tailscale status --json`, `serve status`).
 * `null` in `RemoteStatus` when the CLI is not installed — endpoints then come from interface
 * classification alone, and Settings offers no HTTPS setup.
 */
export const TailscaleState = z.object({
  /** The tailnet IPv4 address, when the node is up. */
  ip: z.string().nullable(),
  /** MagicDNS name without the trailing dot, when MagicDNS is on. */
  dnsName: z.string().nullable(),
  /** The tailnet has the HTTPS certificates feature on, so `tailscale serve` can front the listener. */
  httpsEnabled: z.boolean(),
  /** `tailscale serve` is proxying `https:<port>` to the remote listener right now. */
  serve: z.object({ port: z.number().int() }).nullable(),
});
export type TailscaleState = z.infer<typeof TailscaleState>;

/** `POST /v1/remote/tailscale-serve`: front the remote listener with `tailscale serve` on 443, or stop. */
export const TailscaleServeRequest = z.object({ enabled: z.boolean() });
export type TailscaleServeRequest = z.infer<typeof TailscaleServeRequest>;

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
  core: z.object({
    name: z.string(),
    version: z.string(),
    platform: z.string(),
    /** Stable daemon identity (docs/mobile-notifications.md §4.4); absent from daemons that predate push. */
    coreId: z.string().optional(),
  }),
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
  /**
   * The scheme of each host, parallel to `hosts`; only present when at least one is `https`.
   * An `https` host is reached on 443 with no port — `port` applies to the `http` ones.
   */
  schemes?: EndpointScheme[];
}

/**
 * The QR payload: `fabdesk://pair?v=1&t=<token>&p=<port>&n=<name>&h=<host>…&k=<kind>…&s=<scheme>…`.
 *
 * Hosts repeat as `h=` so the phone can fall back from tailnet to LAN. Kinds travel as a parallel
 * `k=` list, one per host in the same order, rather than inside `h=`: phones built before `k=`
 * existed ignore the parameter and keep parsing `h=` exactly as they always did, and a daemon
 * without kinds simply omits the list. A kind this parser does not know becomes `other`, so a
 * newer daemon can add kinds without breaking an older phone that does know `k=`.
 *
 * Schemes follow the same pattern as `s=`, emitted only when some host is https. An old phone
 * that ignores `s=` tries `http://<name>:<port>` for the MagicDNS host — which still works when
 * the plain listener is reachable over the tailnet, so the link degrades rather than breaks.
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
  const schemes =
    payload.schemes &&
    payload.schemes.length === payload.hosts.length &&
    payload.schemes.some((s) => s === "https")
      ? payload.schemes.map((s) => `s=${s}`)
      : [];
  return [`${PAIRING_URL_PREFIX}?${params.toString()}`, ...hosts, ...kinds, ...schemes].join("&");
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
    schemes: ordered.map(endpointScheme),
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
  const rawSchemes = params.getAll("s");
  // An unknown scheme is treated as http: guessing https at a plain listener would only fail.
  const schemes =
    rawSchemes.length === hosts.length
      ? rawSchemes.map((s): EndpointScheme => (s === "https" ? "https" : "http"))
      : null;
  return {
    version: 1,
    token,
    hosts,
    port,
    name: params.get("n") ?? "fabPlane",
    ...(kinds ? { kinds } : {}),
    ...(schemes ? { schemes } : {}),
  };
}

/**
 * Base URLs to try: every https host first (no ATS exception, and the tailnet already routes it),
 * then the rest in the order the daemon listed them (tailnet first). IPv6 gets bracketed.
 */
export function candidateBaseUrls(
  payload: Pick<PairingPayload, "hosts" | "port" | "schemes" | "kinds">,
): string[] {
  const schemes = payload.schemes?.length === payload.hosts.length ? payload.schemes : null;
  const kinds = payload.kinds?.length === payload.hosts.length ? payload.kinds : null;
  const urls = payload.hosts.flatMap((host, i) => {
    // A relay host is not a listener to dial directly; the phone keeps it as `relayUrl` instead.
    if (kinds?.[i] === "relay") return [];
    const scheme = schemes?.[i] ?? "http";
    return [endpointBaseUrl({ host, scheme, port: scheme === "https" ? 443 : payload.port })];
  });
  return [
    ...urls.filter((u) => u.startsWith("https:")),
    ...urls.filter((u) => !u.startsWith("https:")),
  ];
}
