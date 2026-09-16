/**
 * The hosted pairing link, `https://fabplane.com/pair?host=https://mac.tailnet.ts.net#token=…`.
 *
 * The daemon address rides in the query; the one-time pairing token rides in the fragment, which
 * browsers never send to the server — fabplane.com's logs, its CDN and any Referer header see the
 * host but never the secret. Pure, so the shape is unit-tested without a DOM.
 */

export type PairLinkFailure = "missing-host" | "invalid-host" | "insecure-host" | "missing-token";

export type PairLink =
  | { ok: true; host: string; token: string }
  | { ok: false; reason: PairLinkFailure; message: string };

export interface PairLocation {
  /** `location.search`, with or without the leading `?`. */
  search: string;
  /** `location.hash`, with or without the leading `#`. */
  hash: string;
  /** `location.protocol` of the page, e.g. `https:`. */
  pageProtocol: string;
}

const MESSAGES: Record<PairLinkFailure, string> = {
  "missing-host":
    "This pairing link names no computer. Copy it again from the desktop's pairing dialog.",
  "invalid-host":
    "The computer's address in this link is not a URL. It should look like https://your-mac.tailnet.ts.net.",
  "insecure-host":
    "This page is served over HTTPS, so the browser will not let it talk to a plain-HTTP computer. Give the computer an HTTPS address (a Tailscale HTTPS endpoint) and pair again, or pair from the phone app instead.",
  "missing-token":
    "This pairing link carries no code. It expires three minutes after the desktop shows it; open a fresh one.",
};

/** Is this the pairing page? `/pair` and `/pair/`; nothing else. */
export function isPairPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/pair";
}

/** An origin, normalised: scheme + host (+ port), no path, no trailing slash. */
export function normalizeHost(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // A daemon lives at an origin; anything after it is a copy-paste accident, not a route.
  return url.origin;
}

export function parsePairLink(loc: PairLocation): PairLink {
  const fail = (reason: PairLinkFailure): PairLink => ({
    ok: false,
    reason,
    message: MESSAGES[reason],
  });
  const query = new URLSearchParams(loc.search.replace(/^\?/, ""));
  const rawHost = query.get("host");
  if (!rawHost) return fail("missing-host");
  const host = normalizeHost(rawHost);
  if (!host) return fail("invalid-host");
  // Mixed content: an https page cannot fetch http, and the browser reports it as a generic
  // network failure — so say why up front rather than after a claim that could never work.
  if (loc.pageProtocol === "https:" && host.startsWith("http:")) return fail("insecure-host");
  const fragment = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const token = fragment.get("token")?.trim();
  if (!token) return fail("missing-token");
  return { ok: true, host, token };
}

/** Builds the link the desktop (or the CLI) would print, for docs and tests. */
export function buildPairLink(site: string, host: string, token: string): string {
  const base = site.replace(/\/+$/, "");
  return `${base}/pair?host=${encodeURIComponent(host)}#token=${encodeURIComponent(token)}`;
}

/**
 * What the desktop lists this browser as, from the user agent: "Chrome on macOS", "Safari on
 * iPhone". The daemon caps labels at 80 characters and this stays well under.
 */
export function browserLabel(userAgent: string): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} on ${os}` : browser;
}
