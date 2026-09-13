/** Per-key token buckets: a burst of `capacity`, refilled at `perSecond`. Idle buckets are forgotten. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweep: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSweep = now();
  }

  /** Spends one token for `key`; false when the bucket is empty. */
  take(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSecond);
      b.at = t;
    }
    if (t - this.lastSweep > 60_000) this.sweep(t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drops buckets that would be full again anyway, so an address seen once does not live forever. */
  private sweep(t: number): void {
    this.lastSweep = t;
    const refillMs = (this.capacity / this.perSecond) * 1000;
    for (const [key, b] of this.buckets) if (t - b.at > refillMs) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}
