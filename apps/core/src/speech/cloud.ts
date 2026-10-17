import type { SpeechBackendId } from "@fabdesk/protocol";
import { SpeechProviderError, type SpeechProvider, type SpeechTranscribeInput } from "./provider";
import { cloudBaseUrl, type SpeechCloudConfig } from "./secrets";
import { vocabularyPrompt } from "./vocabulary";

export type SpeechFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createCloudSpeechProvider(opts: {
  config: () => SpeechCloudConfig | null;
  fetchImpl?: SpeechFetch;
  model?: string;
}): SpeechProvider {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    id: "cloud" satisfies SpeechBackendId,
    async ready() {
      return opts.config()
        ? { ready: true }
        : { ready: false, message: "No cloud speech key. Add one in Settings → Voice." };
    },
    async transcribe(input: SpeechTranscribeInput) {
      const config = opts.config();
      if (!config) throw new SpeechProviderError("No cloud speech key is configured.", "unavailable");
      if (input.audio.bytes.byteLength === 0) {
        throw new SpeechProviderError("audio is empty", "invalid_audio");
      }
      const url = `${cloudBaseUrl(config)}/audio/transcriptions`;
      const form = new FormData();
      const name = input.audio.filename?.trim() || guessFilename(input.audio.mime);
      const copy = new ArrayBuffer(input.audio.bytes.byteLength);
      new Uint8Array(copy).set(input.audio.bytes);
      form.append("file", new Blob([copy], { type: input.audio.mime || "audio/webm" }), name);
      form.append("model", opts.model ?? "whisper-1");
      if (input.language.trim()) form.append("language", input.language.trim());
      form.append("prompt", vocabularyPrompt(input.hints ?? []));
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
      });
      if (res.status === 401 || res.status === 403) {
        throw new SpeechProviderError("The cloud speech key was rejected.", "unauthorized");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new SpeechProviderError(
          body.trim() || `Cloud speech failed (${res.status}).`,
          "provider",
        );
      }
      const json = (await res.json()) as { text?: unknown };
      const text = typeof json.text === "string" ? json.text.trim() : "";
      if (!text) throw new SpeechProviderError("Cloud speech returned an empty transcript.", "provider");
      return { text, backend: "cloud", language: input.language };
    },
  };
}

function guessFilename(mime: string): string {
  if (mime.includes("wav")) return "speech.wav";
  if (mime.includes("mp4") || mime.includes("m4a")) return "speech.m4a";
  if (mime.includes("ogg")) return "speech.ogg";
  if (mime.includes("mpeg")) return "speech.mp3";
  return "speech.webm";
}
