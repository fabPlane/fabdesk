/** First-party product analytics: hashed install/account ids, batched to fabplane.com. No PostHog SDK. */
import { createHash, randomUUID } from "node:crypto";
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

type BufferedEvent = {
  uuid: string;
  event: ProductEventName;
  timestamp: string;
  installId: string;
  properties: Record<string, unknown>;
  accountId?: string;
};

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env["FABDESK_TELEMETRY_ENABLED"]?.trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off" && value !== "no";
}

/** SHA-256 hex of the raw identifier. The raw UUID never leaves the machine. */
export function hashTelemetryId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function telemetryOs(platform: NodeJS.Platform = process.platform): string {
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
  private buffer: BufferedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly os: string;
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
      env?: NodeJS.ProcessEnv;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.flushDelayMs = opts.flushDelayMs ?? DEFAULT_FLUSH_MS;
    this.os = telemetryOs(opts.platform ?? process.platform);
    this.arch = opts.arch ?? process.arch;
  }

  /** App start: always `app_open`; `app.active` at most once per 24h. */
  start(): void {
    this.track("app_open");
    const last = this.opts.store.readRaw(LAST_ACTIVE_KEY);
    const lastMs = typeof last === "string" ? Date.parse(last) : Number.NaN;
    if (!Number.isFinite(lastMs) || this.now() - lastMs >= DAY_MS) {
      this.track("app.active");
      this.opts.store.writeRaw(LAST_ACTIVE_KEY, new Date(this.now()).toISOString());
    }
  }

  track(event: ProductEventName, props: ProductEventProps = {}): void {
    if (!this.live()) return;
    const installId = hashTelemetryId(persistInstallId(this.opts.store));
    const identity = this.opts.identity();
    const accountSubject = identity.accountSubject?.trim();
    const properties: Record<string, unknown> = {
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
    const buffered: BufferedEvent = {
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
  }

  /** Drop queued events (opt-out or kill switch). In-flight requests are not cancelled. */
  dropPending(): void {
    this.buffer = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private async sendOnce(): Promise<void> {
    if (!this.live()) {
      this.dropPending();
      return;
    }
    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length === 0) return;
    const origin = this.opts.apiOrigin.replace(/\/+$/, "");
    try {
      const response = await this.fetchImpl(`${origin}/v1/telemetry/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.buffer.unshift(...batch);
        if (this.buffer.length > MAX_BUFFER) this.buffer.splice(MAX_BUFFER);
        logger.debug("product analytics ingest declined", { status: response.status });
      }
    } catch {
      this.buffer.unshift(...batch);
      if (this.buffer.length > MAX_BUFFER) this.buffer.splice(MAX_BUFFER);
    }
  }
}
