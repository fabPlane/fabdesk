/** Which address to try first for a saved connection. Pure, so it is unit-testable. */

/**
 * Addresses to try for a connection, without duplicates: every https address first (a served
 * MagicDNS name needs no cleartext exception and the tailnet already routes it), then the
 * last-known-good, then the rest as the daemon listed them. The probes run in parallel and the
 * first in this order that answers wins, so putting https first costs no time when it is down.
 */
export function connectOrder(connection: { baseUrl: string; candidates: string[] }): string[] {
  const all = [connection.baseUrl, ...connection.candidates];
  const seen = new Set<string>();
  const unique = all.filter((u) => !seen.has(u) && (seen.add(u), true));
  const https = unique.filter((u) => u.startsWith("https:"));
  return [...https, ...unique.filter((u) => !https.includes(u))];
}
