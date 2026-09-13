/**
 * Last-write-wins sync of the portable slice of daemon Settings to GET/PUT /v1/private/settings.
 * Binary paths, the remote listener and keep-core-running stay on this machine.
 */
import type { CloudSettings, Settings } from "@fabdesk/protocol";
import { fetchCloudSettings, putCloudSettings } from "@fabdesk/auth-client";
import type { SettingsRepo } from "./db";
import { logger, errMsg } from "./log";

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
  constructor(
    private readonly opts: {
      apiOrigin: string;
      token: () => string | null;
      settings: SettingsRepo;
      fetchImpl?: typeof fetch;
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
      if (!got.settings) {
        await this.push();
        return;
      }
      if (got.settings.updatedAt > this.stamp()) {
        const patch = patchFromCloud(got.settings);
        if (Object.keys(patch).length > 0) this.opts.settings.patch(patch);
        this.setStamp(got.settings.updatedAt);
      } else if (this.stamp() > got.settings.updatedAt) {
        await this.push();
      }
    } catch (e) {
      logger.warn("cloud settings pull failed", { error: errMsg(e) });
    }
  }

  async push(): Promise<void> {
    const token = this.opts.token();
    if (!token) return;
    const updatedAt = Math.max(Date.now(), this.stamp() + 1);
    const payload = portableFromSettings(this.opts.settings.get(), updatedAt);
    try {
      const put = await putCloudSettings(
        this.opts.fetchImpl ?? fetch,
        this.opts.apiOrigin,
        token,
        payload,
      );
      if (put.ok) this.setStamp(updatedAt);
    } catch (e) {
      logger.warn("cloud settings push failed", { error: errMsg(e) });
    }
  }
}
