/**
 * Which way the phone is talking to a computer, for the Settings card and the switcher: straight
 * to the daemon over the tailnet or LAN, or through the fabplane.com relay. Pure — the transport
 * kind comes from `CoreConnection`, the address from the transport; this only names them.
 *
 * The kind of a direct address is read off the URL rather than stored at pairing time: the
 * daemon classifies by the interface it found the address on, which for a phone amounts to the
 * same ranges (CGNAT and `*.ts.net` are Tailscale, RFC 1918 is LAN), and an address that answered
 * after a move between networks may not be one the pairing listed.
 */
import { hostOf, isPrivateIPv4 } from "./local-network";

/** `EndpointKind` minus `relay`, spelled out so this file needs no protocol import. */
export type DirectKind = "tailscale-https" | "tailscale" | "lan" | "loopback" | "other";

export type ConnectionPath =
  | { via: "direct"; kind: DirectKind; baseUrl: string }
  | { via: "relay"; host: string; baseUrl: string };

/** Tailscale's CGNAT range, 100.64.0.0/10. */
function isTailnetIPv4(host: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/**
 * The host of any http(s) URL, a path, bracketed IPv6 and hostnames included; null when it is
 * not one. A regex rather than `new URL`: React Native's `URL` does not implement `hostname`.
 */
export function anyHostOf(url: string): string | null {
  const plain = hostOf(url);
  if (plain) return plain;
  const m = /^https?:\/\/(?:\[([^\]]+)\]|([^/:?#[\]]+))(?::\d+)?(?:[/?#]|$)/i.exec(url.trim());
  return m?.[1] ?? m?.[2] ?? null;
}

/** How a phone would reach a direct address, judged by the address alone. */
export function classifyBaseUrl(baseUrl: string): DirectKind {
  const host = anyHostOf(baseUrl)?.toLowerCase() ?? "";
  const https = /^https:/i.test(baseUrl);
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return "loopback";
  if (host.endsWith(".ts.net")) return https ? "tailscale-https" : "tailscale";
  if (isTailnetIPv4(host)) return "tailscale";
  if (isPrivateIPv4(host) || /^fe80:/i.test(host)) return "lan";
  return "other";
}

/**
 * The host a relay URL names, shortened to the site when it is fabplane's own
 * (`relay.fabplane.com` and `relay-staging.fabplane.com` both read "fabplane.com").
 */
export function relayHostLabel(relayUrl: string): string {
  const host = anyHostOf(relayUrl)?.toLowerCase() ?? relayUrl;
  if (host === "fabplane.com" || host.endsWith(".fabplane.com")) return "fabplane.com";
  return host;
}

/**
 * The path in use, or null before a transport exists. `via` is the live transport's (`relay`
 * for a `ProxyTransport`); `baseUrl` is what it dials, which through the relay is the
 * `/c/<coreId>` prefix; `relayUrl` is the saved relay, used to name the host.
 */
export function connectionPath(input: {
  via: "direct" | "relay" | null;
  baseUrl: string | null;
  relayUrl?: string | null | undefined;
}): ConnectionPath | null {
  if (!input.via || !input.baseUrl) return null;
  if (input.via === "relay") {
    return {
      via: "relay",
      host: relayHostLabel(input.relayUrl ?? input.baseUrl),
      baseUrl: input.baseUrl,
    };
  }
  return { via: "direct", kind: classifyBaseUrl(input.baseUrl), baseUrl: input.baseUrl };
}

const DIRECT_KIND_LABEL: Record<DirectKind, string> = {
  "tailscale-https": "Tailscale HTTPS",
  tailscale: "Tailscale",
  lan: "LAN",
  loopback: "this machine",
  other: "internet address",
};

/** "Direct · Tailscale", "Direct · LAN", "Via fabplane.com relay". */
export function pathLabel(path: ConnectionPath): string {
  if (path.via === "relay") return `Via ${path.host} relay`;
  return `Direct · ${DIRECT_KIND_LABEL[path.kind]}`;
}

/** The one-line explanation under the path, for the Settings card. */
export function pathHint(path: ConnectionPath): string {
  if (path.via === "relay")
    return `Your computer dials out to ${path.host}; this phone reaches it through that relay, so it works from anywhere. The desktop switches back to a direct address when one answers.`;
  switch (path.kind) {
    case "tailscale-https":
      return "Over your tailnet, with a certificate it already trusts. Nothing goes through fabplane.com.";
    case "tailscale":
      return "Over your tailnet. Nothing goes through fabplane.com.";
    case "lan":
      return "Over the local network. Nothing goes through fabplane.com, and the link is only as private as this Wi-Fi.";
    case "loopback":
      return "A loopback address — this only works from the computer itself.";
    case "other":
      return "A direct address that is neither on a tailnet nor a private network. Nothing goes through fabplane.com.";
  }
}

/**
 * The line the Chats screen shows while the stream is not open. The relay's verdict outranks the
 * generic wording: "reconnecting" through a relay that just said the daemon is gone would hide
 * the one fact the user can act on (wake the computer).
 */
export function streamBannerLabel(input: {
  status: "connecting" | "open" | "reconnecting" | "closed";
  coreOffline: boolean;
  name: string | undefined;
}): string | null {
  if (input.status === "open") return null;
  const name = input.name ?? "your computer";
  if (input.coreOffline)
    return `${name} is offline — the relay is up, but it is not connected. Wake it to continue.`;
  return `${input.status === "reconnecting" ? "Reconnecting…" : "Connecting…"} · ${name}`;
}
