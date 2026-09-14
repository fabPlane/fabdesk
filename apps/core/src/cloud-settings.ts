/**
 * Last-write-wins sync of the portable slice of daemon Settings to GET/PUT /v1/private/settings.
 * Binary paths, the remote listener and keep-core-running stay on this machine.
 */
import type { CloudSettings, Settings } from "@fabdesk/protocol";
import { fetchCloudSettings, overlayCloudSettings, putCloudSettings } from "@fabdesk/auth-client";
import type { SettingsRepo } from "./db";
import { logger, errMsg } from "./log";
import { applyErrorReporting } from "./sentry";

const STAMP_KEY = "cloud_updated_at";

export function portableFromSettings(settings: Settings, updatedAt: number): CloudSettings {
  return {
    schema: 1,
    updatedAt,
    appearance: settings.theme,
    defaultAgent: settings.defaultAgent,
    defaultRuntimeMode: settings.defaultRuntimeMode,
    errorReporting: settings.errorReporting,
    notificationsEnabled: settings.notifications.enabled,
  };
}

export function patchFromCloud(cloud: CloudSettings): Partial<Settings> {
  return {
    ...(cloud.appearance ? { theme: cloud.appearance } : {}),
    ...(cloud.defaultAgent ? { defaultAgent: cloud.defaultAgent } : {}),
    ...(cloud.defaultRuntimeMode ? { defaultRuntimeMode: cloud.defaultRuntimeMode } : {}),
    ...(typeof cloud.errorReporting === "boolean" ? { errorReporting: cloud.errorReporting } : {}),
    ...(typeof cloud.notificationsEnabled === "boolean"
      ? { notifications: { enabled: cloud.notificationsEnabled } }
      : {}),
  };
}

export class CloudSettingsSync {
  private lastRemote: CloudSettings | null = null;

  constructor(
    private readonly opts: {
      apiOrigin: string;
      token: () => string | null;
      settings: SettingsRepo;
      fetchImpl?: typeof fetch;
      applyErrorReporting?: (enabled: boolean) => Promise<void>;
    },
  ) {}

  stamp(): number {
    const raw = this.opts.settings.readRaw(STAMP_KEY);
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  }

  private setStamp(n: number): void {
    this.opts.settings.writeRaw(STAMP_KEY, n);
  }

  async pull(): Promise<void> {
    const token = this.opts.token();
    if (!token) return;
    try {
      const got = await fetchCloudSettings(this.opts.fetchImpl ?? fetch, this.opts.apiOrigin, token);
      if (!got.ok) return;
      this.lastRemote = got.settings;
      if (!got.settings) {
        await this.push();
        return;
      }
      if (got.settings.updatedAt > this.stamp()) {
        const patch = patchFromCloud(got.settings);
        if (Object.keys(patch).length > 0) this.opts.settings.patch(patch);
        this.setStamp(got.settings.updatedAt);
        if (typeof got.settings.errorReporting === "boolean") {
          await (this.opts.applyErrorReporting ?? applyErrorReporting)(got.settings.errorReporting);
        }
      } else if (this.stamp() > got.settings.updatedAt) {
        await this.push();
      }
    } catch (e) {
      logger.warn("cloud settings pull failed", { error: errMsg(e) });
    }
  }

  async push(): Promise<void> {
    // Advance the stamp even when signed out so a later sign-in uploads the local edit
    // instead of treating equal timestamps as already in sync.
    const updatedAt = Math.max(Date.now(), this.stamp() + 1);
    this.setStamp(updatedAt);
    const token = this.opts.token();
    if (!token) return;
    const payload = overlayCloudSettings(
      this.lastRemote,
      portableFromSettings(this.opts.settings.get(), updatedAt),
    );
    try {
      const put = await putCloudSettings(
        this.opts.fetchImpl ?? fetch,
        this.opts.apiOrigin,
        token,
        payload,
      );
      if (put.ok) {
        this.lastRemote = put.settings;
        this.setStamp(put.settings.updatedAt);
      }
    } catch (e) {
      logger.warn("cloud settings push failed", { error: errMsg(e) });
    }
  }
}
