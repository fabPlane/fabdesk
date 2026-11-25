import {
  appendFunnelHandoffToUrl,
  funnelHandoffFromSearchParams,
  type FunnelHandoff,
} from "@fabdesk/protocol";

/** First-touch fields already on a device-login or return_to URL. */
export function funnelHandoffFromLoginSearch(search: string): FunnelHandoff {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return funnelHandoffFromSearchParams(new URLSearchParams(raw));
}

/**
 * Copy ph_id / UTMs / gclid / referrer onto the device-login URL (and nested `return_to`)
 * so `/device` can put them on OAuth `return_to` if the site did not already.
 */
export function appendFunnelToLoginUrl(url: string, handoff: FunnelHandoff): string {
  return appendFunnelHandoffToUrl(url, handoff);
}
