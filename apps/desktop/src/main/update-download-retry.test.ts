import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { retryUpdateDownload } from "./update-download-retry";

test("a timed-out Electron download retries the same transfer and can recover", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await retryUpdateDownload(async () => {
    calls++;
    if (calls === 1) throw new Error("net::ERR_TIMED_OUT");
    if (calls === 2) throw new Error('Cannot download "https://example.test/update.zip", status 503: Service Unavailable');
    return "verified file";
  }, new AbortController().signal, async ms => { delays.push(ms); });
  expect(result).toBe("verified file");
  expect(delays).toEqual([1_000, 3_000]);
  expect(calls).toBe(3);
});

test("a persistent transport failure preserves its error after the third attempt", async () => {
  const error = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  let calls = 0;
  await expect(retryUpdateDownload(async () => { calls++; throw error; },
    new AbortController().signal, async () => {})).rejects.toBe(error);
  expect(calls).toBe(3);
});

test("canceling during backoff immediately ends the wait and prevents a second request", async () => {
  const controller = new AbortController();
  const waiting = Promise.withResolvers<void>();
  let calls = 0;
  const result = retryUpdateDownload(async () => {
    calls++;
    throw new Error("net::ERR_TIMED_OUT");
  }, controller.signal, (ms, signal) => {
    waiting.resolve();
    return delay(ms, undefined, { signal });
  });
  await waiting.promise;
  controller.abort();
  await expect(result).rejects.toHaveProperty("name", "AbortError");
  expect(calls).toBe(1);
});

test("certificate, checksum, missing asset and local installer errors fail immediately", async () => {
  for (const error of [
    new Error("net::ERR_CERT_AUTHORITY_INVALID"),
    Object.assign(new Error("net::ERR_TIMED_OUT"), { code: "ERR_CHECKSUM_MISMATCH" }),
    new Error('Cannot download "https://example.test/x", status 404: Not Found'),
    new Error("Signature verification failed"), new Error("Preparing the installation timed out"),
  ]) {
    let calls = 0;
    await expect(retryUpdateDownload(async () => { calls++; throw error; },
      new AbortController().signal, async () => {})).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});
