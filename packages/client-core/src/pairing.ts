/**
 * The claim exchange the phone runs against a `fabdesk://pair?…` payload. The URL codec itself
 * lives in `@fabdesk/protocol` so the daemon builds exactly what the client parses.
 */
import {
  PairClaimResult,
  candidateBaseUrls,
  type DevicePlatform,
  type PairingPayload,
} from "@fabdesk/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClaimOptions {
  label: string;
  platform: DevicePlatform;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export async function claimPairing(
  baseUrl: string,
  token: string,
  opts: ClaimOptions,
): Promise<PairClaimResult> {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: token, label: opts.label, platform: opts.platform }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `pairing failed (${res.status})`);
    }
    return PairClaimResult.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export interface PairedConnection {
  baseUrl: string;
  result: PairClaimResult;
}

/**
 * Tries each address in turn and keeps the first that answers. The pairing token is one-time, so
 * this is strictly sequential — racing them in parallel would burn the token on a loser.
 */
export async function claimFirstReachable(
  payload: PairingPayload,
  opts: ClaimOptions,
): Promise<PairedConnection> {
  const errors: string[] = [];
  for (const baseUrl of candidateBaseUrls(payload)) {
    try {
      return { baseUrl, result: await claimPairing(baseUrl, payload.token, opts) };
    } catch (e) {
      errors.push(`${baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`could not reach ${payload.name}\n${errors.join("\n")}`);
}
