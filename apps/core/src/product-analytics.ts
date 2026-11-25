/** First-party product analytics: hashed install/account ids, batched to fabplane.com. No PostHog SDK. */
import { createHash, randomUUID } from "node:crypto";
import { FabplaneClient, isFabplaneApiError, type TelemetryEvent } from "fabplane-cli";
import type { BuildKind } from "./build-info";
import type { AuthMode } from "./config";
import { logger } from "./log";

export const PRODUCT_EVENT_NAMES = ["app.active", "app_open", "project_created", "ai_run", "export"] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

const INSTALL_KEY = "product_analytics_install_id";
const LAST_ACTIVE_KEY = "product_analytics_last_active_at";
const DAY_MS = 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BUFFER = 50;
const DEFAULT_FLUSH_MS = 1_500;
const SEND_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_MS = 30_000;
const MAX_RETRY_MS = 30 * 60_000;

export type ProductAnalyticsStore = {
  readRaw(key: string): unknown;
  writeRaw(key: string, value: unknown): void;
};

export type ProductEventProps = {
  draft?: boolean;
  agentId?: string;
  exportTool?: string;
};

export type ProductAnalyticsIdentity = {
  authMode: AuthMode;
  accountSubject?: string;
};

/**
 * The process-level switch. `FABDESK_TELEMETRY_ENABLED` decides when set (`false`/`0`/`off`/`no`
 * are off, anything else on). Unset, analytics is off under CI (`CI=true`), so smoke runs of a
 * built binary never count as installs.
 */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["FABDESK_TELEMETRY_ENABLED"]?.trim().toLowerCase();
  if (value) return value !== "false" && value !== "0" && value !== "off" && value !== "no";
  const ci = env["CI"]?.trim().toLowerCase();
  return !ci || ci === "false" || ci === "0";
}

/**
 * Only a compiled release build reports product events. A daemon run from a checkout (`dev`:
 * tests, `bun run dev`) or a labelled benchmark build (`candidate`) is not an install, and each
 * test's fresh temp home would otherwise register as a new one.
 */
export function analyticsBuild(kind: BuildKind): boolean {
  return kind === "release";
}

/** SHA-256 hex of the raw identifier. The raw UUID never leaves the machine. */
export function hashTelemetryId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function telemetryOs(platform: NodeJS.Platform = process.platform): TelemetryEvent["properties"]["os"] {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  return "other";
}

function persistInstallId(store: ProductAnalyticsStore): string {
  const existing = store.readRaw(INSTALL_KEY);
  if (typeof existing === "string" && UUID.test(existing)) return existing;
  const id = randomUUID();
  store.writeRaw(INSTALL_KEY, id);
  return id;
}

export class ProductAnalytics {
  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private sendController: AbortController | null = null;
  private consentGeneration = 0;
  /** Consecutive failed sends; sets the retry backoff and keeps the log to one warning per streak. */
  private failures = 0;
  /** When this process queued an `app.active` the API has not accepted yet. */
  private activeQueuedAt: number | null = null;
  private readonly client: FabplaneClient;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly os: TelemetryEvent["properties"]["os"];
  private readonly arch: string;

  constructor(
    private readonly opts: {
      apiOrigin: string;
      version: string;
      store: ProductAnalyticsStore;
      allowed: () => boolean;
      identity: () => ProductAnalyticsIdentity;
      fetchImpl?: typeof fetch;
      now?: () => number;
      platform?: NodeJS.Platform;
      arch?: string;
      flushDelayMs?: number;
      /** First retry delay after a failed send; doubles per consecutive failure up to 30 minutes. */
      retryDelayMs?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    const fetchImpl = opts.fetchImpl;
    this.client = new FabplaneClient({
      origin: opts.apiOrigin,
      ...(fetchImpl ? { fetch: (input, init) => fetchImpl(input, init) } : {}),
    });
    this.now = opts.now ?? Date.now;
    this.flushDelayMs = opts.flushDelayMs ?? DEFAULT_FLUSH_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_MS;
    this.os = telemetryOs(opts.platform ?? process.platform);
    this.arch = opts.arch ?? process.arch;
  }

  /**
   * App start: always `app_open`; `app.active` at most once per 24h. The 24h mark is stored only
   * when the API accepts the heartbeat, so one that never arrived is sent again on the next start.
   */
  start(): void {
    this.track("app_open");
    const stored = this.opts.store.readRaw(LAST_ACTIVE_KEY);
    const storedMs = typeof stored === "string" ? Date.parse(stored) : Number.NaN;
    const lastMs = Math.max(Number.isFinite(storedMs) ? storedMs : -Infinity, this.activeQueuedAt ?? -Infinity);
    if (this.now() - lastMs >= DAY_MS && this.track("app.active")) this.activeQueuedAt = this.now();
  }

  track(event: ProductEventName, props: ProductEventProps = {}): boolean {
    if (!this.live()) return false;
    const installId = hashTelemetryId(persistInstallId(this.opts.store));
    const identity = this.opts.identity();
    const accountSubject = identity.accountSubject?.trim();
    const properties: TelemetryEvent["properties"] = {
      appVersion: this.opts.version.slice(0, 32),
      os: this.os,
      arch: this.arch.slice(0, 16),
      authMode: identity.authMode,
      ...(props.draft === true ? { draft: true } : {}),
      ...(props.agentId ? { agentId: props.agentId.slice(0, 32) } : {}),
      ...(props.exportTool && /^export_[a-z0-9_]+$/.test(props.exportTool)
        ? { exportTool: props.exportTool.slice(0, 40) }
        : {}),
    };
    const buffered: TelemetryEvent = {
      uuid: randomUUID(),
      event,
      timestamp: new Date(this.now()).toISOString(),
      installId,
      properties,
      ...(accountSubject ? { accountId: hashTelemetryId(accountSubject) } : {}),
    };
    this.buffer.push(buffered);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    if (this.buffer.length >= 20) void this.flush();
    else this.scheduleFlush();
    return true;
  }

  /** Drop queued events (opt-out or kill switch) and abort an in-flight ingest. */
  dropPending(): void {
    this.consentGeneration += 1;
    this.buffer = [];
    this.activeQueuedAt = null;
    this.failures = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.sendController?.abort();
  }

  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.sending = this.sending.then(() => this.sendOnce()).catch(() => undefined);
    return this.sending;
  }

  private live(): boolean {
    return telemetryEnabled(this.opts.env ?? process.env) && this.opts.allowed();
  }

  private scheduleFlush(delayMs: number = this.flushDelayMs): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  /** A failed send: say so once per streak, then keep or drop the batch and schedule the retry. */
  private sendFailed(batch: TelemetryEvent[], err: unknown): void {
    const status = isFabplaneApiError(err) ? err.status : undefined;
    // The API will never accept a batch it calls malformed; resending it would block newer events.
    const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const detail = {
      events: batch.length,
      ...(status !== undefined ? { status } : { error: err instanceof Error ? err.message : String(err) }),
    };
    if (rejected) {
      if (batch.some((e) => e.event === "app.active")) this.activeQueuedAt = null;
      logger.warn("product analytics batch rejected; dropped", detail);
      return;
    }
    this.failures += 1;
    if (this.failures === 1) logger.warn("product analytics send failed; retrying", detail);
    else logger.debug("product analytics send failed again", { ...detail, failures: this.failures });
    this.buffer.unshift(...batch);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(MAX_BUFFER);
    this.scheduleFlush(Math.min(this.retryDelayMs * 2 ** (this.failures - 1), MAX_RETRY_MS));
  }

  private async sendOnce(): Promise<void> {
    if (!this.live()) {
      this.dropPending();
      return;
    }
    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length === 0) return;
    const generation = this.consentGeneration;
    const sendController = new AbortController();
    this.sendController = sendController;
    try {
      await this.client.postTelemetryEvents(batch, {
        signal: AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), sendController.signal]),
      });
      if (this.failures > 0) logger.info("product analytics send recovered", { failures: this.failures });
      this.failures = 0;
      const active = batch.findLast((e) => e.event === "app.active");
      if (active && this.consentGeneration === generation) {
        this.opts.store.writeRaw(LAST_ACTIVE_KEY, active.timestamp);
      }
    } catch (err) {
      // Consent revoked mid-send (dropPending aborted it): nothing to keep, nothing to report.
      if (this.consentGeneration !== generation) return;
      if (this.live()) this.sendFailed(batch, err);
      else this.activeQueuedAt = null;
    } finally {
      if (this.sendController === sendController) this.sendController = null;
    }
  }
}
