/**
 * Remembers the `/v1/auth/me` verdict for a bearer so a daemon that reconnects (network blip,
 * relay restart, replaced socket) does not hit the API every time. Keys are SHA-256 of the
 * bearer; the bearer itself is never stored. A revoked session therefore stays usable on the
 * relay for at most `ttlMs` — the accepted trade-off for a five-minute window. Only verdicts are
 * cached; an API outage (5xx, network error) is never remembered.
 */
import { sha256 } from "./hash";

export type AuthVerdict = { userId: string | null };

export class AuthCache {
  private readonly entries = new Map<string, { verdict: AuthVerdict; expiresAt: number }>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(bearer: string): AuthVerdict | undefined {
    if (this.ttlMs <= 0) return undefined;
    const key = sha256(bearer);
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.hits += 1;
      return hit.verdict;
    }
    if (hit) this.entries.delete(key);
    this.misses += 1;
    return undefined;
  }

  set(bearer: string, verdict: AuthVerdict): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) this.sweep();
    if (this.entries.size >= this.maxEntries) {
      // Still full after dropping expired entries: forget the oldest insertion.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(sha256(bearer), { verdict, expiresAt: this.now() + this.ttlMs });
  }

  /** Drops a bearer early. */
  forget(bearer: string): void {
    this.entries.delete(sha256(bearer));
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }
}
