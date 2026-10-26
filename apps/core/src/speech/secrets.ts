import type { SettingsRepo } from "../db";

export const SPEECH_CLOUD_SECRET_KEY = "speech_cloud";

export interface SpeechCloudConfig {
  apiKey: string;
  baseUrl: string | null;
}

export const DEFAULT_SPEECH_CLOUD_URL = "https://api.openai.com/v1";

export function readSpeechCloud(
  settings: Pick<SettingsRepo, "readRaw">,
  env: NodeJS.ProcessEnv = process.env,
): SpeechCloudConfig | null {
  const fromEnv = env["FABDESK_SPEECH_API_KEY"]?.trim();
  const envUrl = env["FABDESK_SPEECH_API_URL"]?.trim() || null;
  const raw = settings.readRaw(SPEECH_CLOUD_SECRET_KEY);
  if (raw && typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : "";
    const storedUrl = typeof rec.baseUrl === "string" && rec.baseUrl.trim() ? rec.baseUrl.trim() : null;
    if (apiKey) return { apiKey, baseUrl: envUrl ?? storedUrl };
  }
  if (fromEnv) return { apiKey: fromEnv, baseUrl: envUrl };
  return null;
}

export function writeSpeechCloud(
  settings: Pick<SettingsRepo, "writeRaw">,
  config: SpeechCloudConfig | null,
): void {
  if (!config?.apiKey.trim()) {
    settings.writeRaw(SPEECH_CLOUD_SECRET_KEY, null);
    return;
  }
  settings.writeRaw(SPEECH_CLOUD_SECRET_KEY, {
    apiKey: config.apiKey.trim(),
    baseUrl: config.baseUrl?.trim() || null,
  });
}

export function cloudBaseUrl(config: SpeechCloudConfig | null): string {
  return (config?.baseUrl?.replace(/\/+$/, "") || DEFAULT_SPEECH_CLOUD_URL).replace(/\/+$/, "");
}
