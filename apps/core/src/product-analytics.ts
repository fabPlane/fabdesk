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
  private readonly client: FabplaneClient;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
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
    this.os = telemetryOs(opts.platform ?? process.platform);
    this.arch = opts.arch ?? process.arch;
  }

  /** App start: always `app_open`; `app.active` at most once per 24h. */
  start(): void {
    this.track("app_open");
    const last = this.opts.store.readRaw(LAST_ACTIVE_KEY);
    const lastMs = typeof last === "string" ? Date.parse(last) : Number.NaN;
    if (!Number.isFinite(lastMs) || this.now() - lastMs >= DAY_MS) {
      if (this.track("app.active")) {
        this.opts.store.writeRaw(LAST_ACTIVE_KEY, new Date(this.now()).toISOString());
      }
    }
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
    const generation = this.consentGeneration;
    const sendController = new AbortController();
    this.sendController = sendController;
    try {
      await this.client.postTelemetryEvents(batch, {
        signal: AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), sendController.signal]),
      });
    } catch (err) {
      if (this.consentGeneration === generation && this.live()) {
        this.buffer.unshift(...batch);
        if (this.buffer.length > MAX_BUFFER) this.buffer.splice(MAX_BUFFER);
      }
      if (isFabplaneApiError(err)) {
        logger.debug("product analytics ingest declined", { status: err.status });
      }
    } finally {
      if (this.sendController === sendController) this.sendController = null;
    }
  }
}
