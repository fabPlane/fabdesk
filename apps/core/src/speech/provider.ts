import type { SpeechBackendId } from "@fabdesk/protocol";

export interface SpeechAudio {
  bytes: Uint8Array;
  mime: string;
  filename?: string;
}

export interface SpeechTranscribeInput {
  audio: SpeechAudio;
  language: string;
  /** Extra hint words merged with the hardware vocabulary. */
  hints?: string[];
}

export interface SpeechTranscribeResult {
  text: string;
  language?: string;
  backend: SpeechBackendId;
}

export interface SpeechProvider {
  readonly id: SpeechBackendId;
  ready(): Promise<{ ready: boolean; message?: string }>;
  transcribe(input: SpeechTranscribeInput): Promise<SpeechTranscribeResult>;
}

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "invalid_audio" | "provider" | "unauthorized" = "provider",
  ) {
    super(message);
    this.name = "SpeechProviderError";
  }
}

export function createFakeSpeechProvider(
  opts: {
    id?: SpeechBackendId;
    text?: string;
    ready?: boolean;
    message?: string;
    onTranscribe?: (input: SpeechTranscribeInput) => void;
  } = {},
): SpeechProvider {
  const id = opts.id ?? "cloud";
  return {
    id,
    async ready() {
      return opts.ready === false
        ? { ready: false, ...(opts.message ? { message: opts.message } : {}) }
        : { ready: true };
    },
    async transcribe(input) {
      opts.onTranscribe?.(input);
      if (opts.ready === false) {
        throw new SpeechProviderError(opts.message ?? "fake provider is not ready", "unavailable");
      }
      if (input.audio.bytes.byteLength === 0) {
        throw new SpeechProviderError("audio is empty", "invalid_audio");
      }
      return { text: opts.text ?? "add a USB-C jack", backend: id, language: input.language };
    },
  };
}
