/**
 * The claim exchange the phone runs against a `fabdesk://pair?…` payload. The URL codec itself
 * lives in `@fabdesk/protocol` so the daemon builds exactly what the client parses.
 */
import {
  PairClaimResult,
  claimBaseUrls,
  type DevicePlatform,
  type PairingPayload,
} from "@fabdesk/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClaimOptions {
  label: string;
  platform: DevicePlatform;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** How long `/health` gets before an address is skipped. Short: the user is holding up a QR code. */
  probeTimeoutMs?: number;
}

/**
 * The daemon answered and said no — the code is spent, expired or unknown. Distinct from a
 * transport failure because no other address can change the answer: it is the same daemon.
 */
export class PairingRefusedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PairingRefusedError";
    this.status = status;
  }
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export async function claimPairing(
  baseUrl: string,
  token: string,
  opts: ClaimOptions,
): Promise<PairClaimResult> {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const t = withTimeout(opts.timeoutMs ?? 5000);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: token, label: opts.label, platform: opts.platform }),
      signal: t.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new PairingRefusedError(body?.error ?? `pairing failed (${res.status})`, res.status);
    }
    return PairClaimResult.parse(await res.json());
  } finally {
    t.done();
  }
}

/**
 * Why `GET /health` on this address did not answer like a fabPlane daemon, or null if it did.
 * Unauthenticated, so it costs nothing — unlike a claim, which spends one of the code's attempts.
 */
async function unreachableReason(
  baseUrl: string,
  doFetch: FetchLike,
  timeoutMs: number,
): Promise<string | null> {
  const t = withTimeout(timeoutMs);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: t.signal });
    if (!res.ok) return `health returned ${res.status}`;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true ? null : "not a fabPlane daemon";
  } catch (e) {
    if (t.signal.aborted) return `no answer within ${timeoutMs} ms`;
    return e instanceof Error ? e.message : String(e);
  } finally {
    t.done();
  }
}

export interface PairedConnection {
  baseUrl: string;
  result: PairClaimResult;
}

/**
 * Probes each address in turn and claims on the first whose `/health` answers. The pairing token
 * is one-time, so this is strictly sequential — racing in parallel would burn the token on a
 * loser — and a claim is only ever sent where a daemon is known to be listening, so scanning on
 * the wrong network costs nothing. A refusal from that daemon ends the search: every address is
 * the same machine, and another attempt would only spend more of the code's budget.
 */
export async function claimFirstReachable(
  payload: PairingPayload,
  opts: ClaimOptions,
): Promise<PairedConnection> {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2500;
  const errors: string[] = [];
  for (const baseUrl of claimBaseUrls(payload)) {
    const reason = await unreachableReason(baseUrl, doFetch, probeTimeoutMs);
    if (reason !== null) {
      errors.push(`${baseUrl}: ${reason}`);
      continue;
    }
    try {
      return { baseUrl, result: await claimPairing(baseUrl, payload.token, opts) };
    } catch (e) {
      if (e instanceof PairingRefusedError) throw e;
      errors.push(`${baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`could not reach ${payload.name}\n${errors.join("\n")}`);
}
