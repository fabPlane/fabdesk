/** Speak-to-the-agent transcription: status, transcript, and the cloud-key write body. */
import { z } from "zod/v4";

export const SpeechBackendId = z.enum(["on_device", "cloud", "local"]);
export type SpeechBackendId = z.infer<typeof SpeechBackendId>;

export const SpeechBackendStatus = z.object({
  id: SpeechBackendId,
  ready: z.boolean(),
  /** Short reason when `ready` is false — safe to show in the composer. */
  message: z.string().optional(),
});
export type SpeechBackendStatus = z.infer<typeof SpeechBackendStatus>;

/** `GET /v1/speech/status` — never includes the cloud API key. */
export const SpeechStatus = z.object({
  voice: z.object({
    provider: z.enum(["auto", "on_device", "cloud", "local"]),
    language: z.string(),
    pushToTalkMode: z.enum(["hold", "toggle"]),
    pushToTalkShortcut: z.string(),
  }),
  /** The backend `auto` (or the chosen provider) will use right now. Null if none is ready. */
  active: SpeechBackendId.nullable(),
  backends: z.array(SpeechBackendStatus),
  /** A cloud key is stored on this daemon. The key itself is never returned. */
  cloudConfigured: z.boolean(),
  /** Optional custom transcription endpoint; empty means the default OpenAI-compatible URL. */
  cloudBaseUrl: z.string().nullable(),
  localInstalled: z.boolean(),
});
export type SpeechStatus = z.infer<typeof SpeechStatus>;

export const SpeechTranscript = z.object({
  text: z.string(),
  language: z.string().optional(),
  backend: SpeechBackendId,
});
export type SpeechTranscript = z.infer<typeof SpeechTranscript>;

/** `PUT /v1/speech/cloud` — daemon token, local listener only. */
export const SpeechCloudSecret = z.object({
  apiKey: z.string().min(1).max(256),
  /** OpenAI-compatible base, e.g. `https://api.openai.com/v1`. Empty/omit = default. */
  baseUrl: z.string().trim().max(200).nullable().optional(),
});
export type SpeechCloudSecret = z.infer<typeof SpeechCloudSecret>;
