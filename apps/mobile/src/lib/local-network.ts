/**
 * Picking addresses to touch so iOS asks for Local Network permission *before* the user scans.
 *
 * On iOS 14+ the first connection to a local-network address puts up a system prompt, and the
 * request that triggered it fails — which, mid-pairing, reads as "can't reach that computer". A
 * throwaway `/health` probe from the Connections screen moves the prompt to a moment when nothing
 * is at stake. Tailnet (CGNAT) addresses do not count as local, so only RFC 1918 and link-local
 * targets are worth touching. Pure, so Bun can test it; the screen adds `fetch`.
 */

const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/;

/** RFC 1918 or link-local — what iOS treats as the local network for the permission prompt. */
export function isPrivateIPv4(host: string): boolean {
  return PRIVATE_IPV4.test(host);
}

/** The host of an `http://host:port` base URL, or null when it is not one (IPv6 included). */
export function hostOf(baseUrl: string): string | null {
  const m = /^https?:\/\/([^/:[\]]+)(?::\d+)?\/?$/.exec(baseUrl);
  return m?.[1] ?? null;
}

/**
 * What to probe, most useful first: saved addresses that are on a private network (a real daemon
 * may even answer), then the gateway of the network the phone is on, then a fixed private address
 * as a last resort so the prompt still appears on a phone that has never paired.
 */
export function warmupTargets(input: {
  candidates: string[];
  deviceIp: string | null;
  port: number;
}): string[] {
  const out: string[] = [];
  const add = (url: string) => {
    if (!out.includes(url)) out.push(url);
  };
  for (const url of input.candidates) {
    const host = hostOf(url);
    if (host && isPrivateIPv4(host)) add(url.replace(/\/$/, ""));
  }
  if (input.deviceIp && isPrivateIPv4(input.deviceIp)) {
    const gateway = `${input.deviceIp.split(".").slice(0, 3).join(".")}.1`;
    add(`http://${gateway}:${input.port}`);
  }
  if (out.length === 0) add(`http://192.168.1.1:${input.port}`);
  return out;
}
