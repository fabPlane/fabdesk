/**
 * Turning the route params expo-router hands `/pair` back into the `fabdesk://pair?…` link the
 * desktop generated, so the one parser in `@fabdesk/protocol` stays authoritative. A repeated
 * key (`h`, one per address) arrives as an array.
 */
import { PAIRING_URL_PREFIX } from "@fabdesk/protocol";

export type RouteParams = Record<string, string | string[] | undefined>;

export function pairingUrlFromParams(params: RouteParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
      search.append(key, v);
  }
  return `${PAIRING_URL_PREFIX}?${search.toString()}`;
}
