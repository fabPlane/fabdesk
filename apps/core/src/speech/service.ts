import type { SpeechBackendId, SpeechStatus, VoiceSettings } from "@fabdesk/protocol";
import type { SettingsRepo } from "../db";
import { createCloudSpeechProvider } from "./cloud";
import { createLocalSpeechProvider, installLocalSpeechModel, localSpeechPaths } from "./local";
import {
  SpeechProviderError,
  type SpeechAudio,
  type SpeechProvider,
  type SpeechTranscribeResult,
} from "./provider";
import { readSpeechCloud, writeSpeechCloud, type SpeechCloudConfig } from "./secrets";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface SpeechService {
  status(): Promise<SpeechStatus>;
  transcribe(input: {
    audio: SpeechAudio;
    language?: string;
    provider?: VoiceSettings["provider"];
  }): Promise<SpeechTranscribeResult>;
  setCloud(config: SpeechCloudConfig | null): void;
  installLocal(): Promise<{ modelPath: string }>;
}

export function createSpeechService(opts: {
  settings: SettingsRepo;
  home: string;
  env?: NodeJS.ProcessEnv;
  cloud?: SpeechProvider;
  local?: SpeechProvider;
  installLocal?: () => Promise<{ modelPath: string }>;
}): SpeechService {
  const env = opts.env ?? process.env;
  const cloud =
    opts.cloud ??
    createCloudSpeechProvider({
      config: () => readSpeechCloud(opts.settings, env),
    });
  const local = opts.local ?? createLocalSpeechProvider({ home: opts.home });
  const install = opts.installLocal ?? (() => installLocalSpeechModel({ home: opts.home }));

  const voice = (): VoiceSettings => opts.settings.get().voice;

  return {
    async status() {
      const v = voice();
      const cloudCfg = readSpeechCloud(opts.settings, env);
      const [cloudReady, localReady] = await Promise.all([cloud.ready(), local.ready()]);
      const backends: SpeechStatus["backends"] = [
        {
          id: "on_device",
          ready: true,
          message: "Uses this computer or phone's speech API. Checked when you tap the mic.",
        },
        {
          id: "cloud",
          ready: cloudReady.ready,
          ...(cloudReady.message ? { message: cloudReady.message } : {}),
        },
        {
          id: "local",
          ready: localReady.ready,
          ...(localReady.message ? { message: localReady.message } : {}),
        },
      ];
      return {
        voice: v,
        active: pickActive(v.provider, { cloud: cloudReady.ready, local: localReady.ready }),
        backends,
        cloudConfigured: !!cloudCfg,
        cloudBaseUrl: cloudCfg?.baseUrl ?? null,
        localInstalled: localReady.ready,
      };
    },
    async transcribe(input) {
      if (input.audio.bytes.byteLength === 0) {
        throw new SpeechProviderError("audio is empty", "invalid_audio");
      }
      if (input.audio.bytes.byteLength > MAX_AUDIO_BYTES) {
        throw new SpeechProviderError("audio is too large (25 MB limit)", "invalid_audio");
      }
      const v = voice();
      const provider = input.provider ?? v.provider;
      if (provider === "on_device") {
        throw new SpeechProviderError(
          "On-device speech runs in the app, not on the daemon. Use the mic button, or pick cloud / local.",
          "unavailable",
        );
      }
      const [cloudReady, localReady] = await Promise.all([cloud.ready(), local.ready()]);
      const backend = pickActive(provider === "auto" ? "auto" : provider, {
        cloud: cloudReady.ready,
        local: localReady.ready,
      });
      if (!backend || backend === "on_device") {
        throw new SpeechProviderError(
          "No speech provider is ready. Add a cloud key in Settings → Voice or install the local model.",
          "unavailable",
        );
      }
      const chosen = backend === "cloud" ? cloud : local;
      return chosen.transcribe({
        audio: input.audio,
        language: input.language?.trim() || v.language,
      });
    },
    setCloud(config) {
      writeSpeechCloud(opts.settings, config);
    },
    installLocal() {
      return install();
    },
  };
}

export function pickActive(
  provider: VoiceSettings["provider"],
  ready: { cloud: boolean; local: boolean },
): SpeechBackendId | null {
  if (provider === "on_device") return "on_device";
  if (provider === "cloud") return ready.cloud ? "cloud" : null;
  if (provider === "local") return ready.local ? "local" : null;
  if (ready.cloud) return "cloud";
  if (ready.local) return "local";
  return "on_device";
}

export function localModelPath(home: string): string {
  return localSpeechPaths(home).modelPath;
}
