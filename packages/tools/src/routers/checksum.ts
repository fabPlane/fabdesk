import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

export const SHA256_HEX = /^[a-f0-9]{64}$/;

export function assertSha256(value: string): string {
  const hex = value.trim().toLowerCase();
  if (!SHA256_HEX.test(hex)) throw new Error("checksum must be a 64-character lowercase hex SHA-256");
  return hex;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export async function verifyFileSha256(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  const want = assertSha256(expected);
  if (actual !== want)
    throw new Error(`checksum mismatch: expected ${want.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
}

/** Stream a response body to disk while hashing; rejects size and checksum mismatches. */
export async function downloadAndVerify(opts: {
  url: string;
  dest: string;
  sha256: string;
  signal?: AbortSignal;
  bytes?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (received: number, total: number) => void;
}): Promise<{ received: number; sha256: string }> {
  const expected = assertSha256(opts.sha256);
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  if (opts.bytes !== undefined && opts.bytes > maxBytes)
    throw new Error(`artifact advertises ${opts.bytes} bytes, over the ${maxBytes} byte limit`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(opts.url, { ...(opts.signal ? { signal: opts.signal } : {}) });
  } catch (error) {
    throw offlineOrFetchError(error, opts.url);
  }
  if (!response.ok) throw new Error(`download failed (${response.status}) from ${opts.url}`);
  if (!response.body) throw new Error(`empty download body from ${opts.url}`);
  const hash = createHash("sha256");
  const file = await open(opts.dest, "wx", 0o600);
  let received = 0;
  const total = opts.bytes ?? Number(response.headers.get("content-length") ?? 0);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      opts.signal?.throwIfAborted();
      received += chunk.length;
      if (received > maxBytes) throw new Error(`download exceeded the ${maxBytes} byte limit`);
      if (opts.bytes !== undefined && received > opts.bytes)
        throw new Error("download exceeds advertised size");
      hash.update(chunk);
      await file.write(chunk);
      opts.onProgress?.(received, total);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  if (opts.bytes !== undefined && received !== opts.bytes)
    throw new Error(`download size mismatch: expected ${opts.bytes} bytes, got ${received}`);
  const actual = hash.digest("hex");
  if (actual !== expected)
    throw new Error(`checksum mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
  return { received, sha256: actual };
}

export function offlineOrFetchError(error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? ((error as Error & { cause?: { code?: string } }).cause?.code ?? "") : "";
  const offline =
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|failed to fetch|network|offline|certificate|Unable to connect|ConnectionRefused|FailedToOpenSocket|ConnectionClosed/i.test(
      `${message} ${cause}`,
    );
  if (offline)
    return new Error(
      `offline: cannot download ${url}. Connect to the internet, or place a verified artifact in the fabdesk routers directory.`,
    );
  return error instanceof Error ? error : new Error(message);
}
