import { classifyMediaError } from "./media-errors";
import {
  speechRecognitionCtor,
  transcriptsFromEvent,
  type BrowserSpeechRecognition,
} from "./web-speech";

export interface VoiceCaptureHandlers {
  onLevel: (level: number) => void;
  onPartial: (text: string) => void;
  onError: (error: { type: "permission_denied" | "unavailable"; message: string }) => void;
}

export interface VoiceCaptureResult {
  blob: Blob;
  mime: string;
  /** Best on-device transcript gathered while recording. */
  onDeviceText: string;
}

export interface VoiceCapture {
  start(language: string): Promise<void>;
  stop(): Promise<VoiceCaptureResult | null>;
  cancel(): void;
}

export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

/**
 * Capture microphone audio in the renderer. The blob is dropped by the caller after
 * transcription; this object does not write files.
 */
export function createVoiceCapture(
  handlers: VoiceCaptureHandlers,
  deps: {
    getUserMedia?: GetUserMedia;
    speechCtor?: ReturnType<typeof speechRecognitionCtor>;
    audioContext?: { new (): AudioContext };
  } = {},
): VoiceCapture {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let mime = "audio/webm";
  let recognition: BrowserSpeechRecognition | null = null;
  let finalText = "";
  let raf = 0;
  let analyser: AnalyserNode | null = null;
  let context: AudioContext | null = null;

  const teardown = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    recognition?.abort();
    recognition = null;
    try {
      recorder?.stop();
    } catch {
      /* already stopped */
    }
    recorder = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void context?.close();
    context = null;
    analyser = null;
  };

  return {
    async start(language) {
      const gum =
        deps.getUserMedia ??
        (typeof navigator !== "undefined" ? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices) : undefined);
      if (!gum) {
        handlers.onError({ type: "unavailable", message: "This window cannot open the microphone." });
        return;
      }
      try {
        stream = await gum({ audio: true, video: false });
      } catch (e) {
        handlers.onError(classifyMediaError(e));
        return;
      }
      chunks = [];
      finalText = "";
      mime = pickMime();
      try {
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch {
        recorder = new MediaRecorder(stream);
        mime = recorder.mimeType || "audio/webm";
      }
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.start(200);

      const Ctor = deps.audioContext ?? (typeof AudioContext !== "undefined" ? AudioContext : undefined);
      if (Ctor) {
        context = new Ctor();
        const source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (const s of buf) peak = Math.max(peak, Math.abs(s - 128) / 128);
          handlers.onLevel(peak);
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }

      const Rec = deps.speechCtor ?? speechRecognitionCtor();
      if (Rec) {
        recognition = new Rec();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = language || "en";
        recognition.onresult = (event) => {
          const { partial, final } = transcriptsFromEvent(event);
          if (final) finalText = finalText ? `${finalText} ${final}` : final;
          handlers.onPartial(finalText ? (partial ? `${finalText} ${partial}` : finalText) : partial);
        };
        recognition.onerror = () => {
          /* keep recording; core transcription is the fallback */
        };
        try {
          recognition.start();
        } catch {
          recognition = null;
        }
      }
    },
    stop() {
      return new Promise((resolve) => {
        const rec = recorder;
        const currentMime = mime;
        const text = finalText;
        const finish = () => {
          const blob = chunks.length ? new Blob(chunks, { type: currentMime }) : new Blob();
          chunks = [];
          teardown();
          resolve(blob.size ? { blob, mime: currentMime, onDeviceText: text } : { blob, mime: currentMime, onDeviceText: text });
        };
        if (!rec || rec.state === "inactive") {
          finish();
          return;
        }
        rec.onstop = () => finish();
        try {
          rec.stop();
        } catch {
          finish();
        }
      });
    },
    cancel() {
      chunks = [];
      teardown();
    },
  };
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "audio/webm";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "audio/webm";
}
