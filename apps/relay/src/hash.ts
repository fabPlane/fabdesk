/**
 * Short, stable, one-way identifiers for logs and diagnostics. `coreId`s and `userId`s never
 * appear in relay output; twelve hex characters of SHA-256 are enough to correlate lines from
 * the same peer without letting anyone reverse the value.
 */
export function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

/** Full SHA-256 hex, used as a cache key so a bearer is never held in memory in the clear. */
export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
