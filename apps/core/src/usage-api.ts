/** Installation-authenticated usage archive upload. R2 credentials stay on the API. */
import { createHash } from "node:crypto";
import { ArchiveConsentRevokedError, ArchiveRecordTooLargeError, type ArchiveWriter } from "./usage-archive";

type Installation = { installationId: string; token: string };
export type InstallationStore = {
  readRaw(key: string): unknown;
  writeRaw(key: string, value: unknown): void;
};

const INSTALLATION_KEY = "usage_archive_installation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The API's `MAX_ARCHIVE_BYTES`; larger records are rejected with 413, so they are not sent. */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/**
 * Upload pacing against the API's limits: 120 uploads a minute per installation (we stay at 100),
 * retrying 429, 5xx and network failures a few times. A `Retry-After` longer than the cap (a
 * daily limit) fails the write at once; the caller retries the backfill later.
 */
export type UploadPacing = {
  minIntervalMs: number;
  retryDelaysMs: readonly number[];
  maxRetryAfterMs: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

const DEFAULT_PACING: UploadPacing = {
  minIntervalMs: 600,
  retryDelaysMs: [5_000, 30_000, 120_000],
  maxRetryAfterMs: 5 * 60_000,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

class RetryableUploadError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** `Retry-After` as delta-seconds or an HTTP date; null when absent or unparseable. */
function retryAfterMs(response: Response, now: number): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function validInstallation(value: unknown): value is Installation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["installationId"] === "string" && UUID.test(record["installationId"])
    && typeof record["token"] === "string"
    && new RegExp(`^${record["installationId"]}\\.[a-f0-9]{64}$`).test(record["token"]);
}

function requireConsent(allowed: () => boolean, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (!allowed()) throw new ArchiveConsentRevokedError();
}

export class UsageApiArchiveWriter implements ArchiveWriter {
  private installationTask: Promise<Installation> | null = null;
  private readonly pacing: UploadPacing;
  private readonly closing = new AbortController();
  private pending = new AbortController();
  private nextUploadAt = 0;
  get id(): string {
    return `api:${this.apiOrigin.replace(/\/+$/, "")}`;
  }
  constructor(
    private readonly apiOrigin: string,
    private readonly token: () => string | null,
    private readonly installationStore: InstallationStore,
    private readonly fetchImpl: typeof fetch = fetch,
    pacing: Partial<UploadPacing> = {},
  ) {
    this.pacing = { ...DEFAULT_PACING, ...pacing };
  }

  /** Cancels pending waits and requests so the daemon can shut down mid-backfill. */
  close(): void {
    this.closing.abort(new Error("usage archive closed"));
  }

  /** Opt-out cancels the old consent period, without preventing a later opt-in. */
  cancelPending(): void {
    this.pending.abort(new ArchiveConsentRevokedError());
    this.pending = new AbortController();
    this.installationTask = null;
    this.nextUploadAt = 0;
  }

  private installation(allowed: () => boolean, signal: AbortSignal): Promise<Installation> {
    requireConsent(allowed, signal);
    const stored = this.installationStore.readRaw(INSTALLATION_KEY);
    if (validInstallation(stored)) return Promise.resolve(stored);
    if (this.installationTask) return this.installationTask;
    const pending = (async () => {
      const response = await this.fetchImpl(`${this.apiOrigin.replace(/\/+$/, "")}/v1/usage-archive/installation`, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      requireConsent(allowed, signal);
      if (!response.ok) throw new Error(`usage archive registration failed (${response.status})`);
      const installation: unknown = await response.json();
      requireConsent(allowed, signal);
      if (!validInstallation(installation)) throw new Error("usage archive registration returned invalid credentials");
      this.installationStore.writeRaw(INSTALLATION_KEY, installation);
      return installation;
    })().finally(() => {
      // An aborted registration may settle after a new consent period has already started one.
      if (this.installationTask === pending) this.installationTask = null;
    });
    this.installationTask = pending;
    return pending;
  }

  async write(key: string, content: string, allowed: () => boolean = () => true): Promise<void> {
    const signal = AbortSignal.any([this.closing.signal, this.pending.signal]);
    requireConsent(allowed, signal);
    const body = Buffer.from(content, "utf8");
    if (body.byteLength > MAX_UPLOAD_BYTES) throw new ArchiveRecordTooLargeError(key, body.byteLength);
    const installation = await this.installation(allowed, signal);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.upload(installation, key, body, allowed, signal);
        return;
      } catch (error) {
        requireConsent(allowed, signal);
        if (!(error instanceof RetryableUploadError)) throw error;
        const delay = error.retryAfterMs ?? this.pacing.retryDelaysMs[attempt];
        if (delay === undefined || delay > this.pacing.maxRetryAfterMs || attempt >= this.pacing.retryDelaysMs.length)
          throw new Error(error.message);
        await this.pacing.sleep(delay, signal);
      }
    }
  }

  private async upload(
    installation: Installation, key: string, body: Buffer<ArrayBuffer>, allowed: () => boolean, signal: AbortSignal,
  ): Promise<void> {
    requireConsent(allowed, signal);
    const now = Date.now();
    const wait = this.nextUploadAt - now;
    this.nextUploadAt = Math.max(now, this.nextUploadAt) + this.pacing.minIntervalMs;
    if (wait > 0) await this.pacing.sleep(wait, signal);
    requireConsent(allowed, signal);
    const bearer = this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiOrigin.replace(/\/+$/, "")}/v1/usage-archive`, {
        method: "PUT",
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          "content-type": "application/json",
          "x-fabdesk-installation-token": installation.token,
          "x-fabdesk-archive-key": key,
          "x-fabdesk-content-sha256": createHash("sha256").update(body).digest("hex"),
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
    } catch (error) {
      requireConsent(allowed, signal);
      throw new RetryableUploadError(`usage archive upload failed (${error instanceof Error ? error.message : String(error)})`);
    }
    // Once the server has accepted the record it is backed up; let the ledger record that.
    if (response.ok) return;
    requireConsent(allowed, signal);
    const message = `usage archive upload failed (${response.status})`;
    if (response.status === 413) throw new ArchiveRecordTooLargeError(key, body.byteLength);
    if (response.status === 429 || response.status >= 500)
      throw new RetryableUploadError(message, retryAfterMs(response, Date.now()));
    throw new Error(message);
  }
}
