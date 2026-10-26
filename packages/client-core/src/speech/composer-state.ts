/**
 * Composer voice input: idle → recording → transcribing → editing → sent | cancelled.
 * Pure so the desktop composer and the phone hold-to-talk share one machine.
 */

export const VOICE_PHASES = [
  "idle",
  "recording",
  "transcribing",
  "editing",
  "sent",
  "cancelled",
] as const;
export type VoicePhase = (typeof VOICE_PHASES)[number];

export type VoiceMode = "hold" | "toggle";

export type VoiceErrorKind = "permission_denied" | "unavailable" | "transcribe_failed" | "aborted";

export interface VoiceState {
  phase: VoicePhase;
  mode: VoiceMode;
  /** Live / partial words while the mic is open. */
  partial: string;
  /** Final transcript the person can edit before send. */
  transcript: string;
  /** 0–1 peak from the input meter; 0 when not recording. */
  level: number;
  error: string | null;
  errorKind: VoiceErrorKind | null;
}

export type VoiceEvent =
  | { type: "start"; mode?: VoiceMode }
  | { type: "permission_denied"; message?: string }
  | { type: "unavailable"; message?: string }
  | { type: "level"; value: number }
  | { type: "partial"; text: string }
  | { type: "stop" }
  | { type: "transcript"; text: string }
  | { type: "transcribe_failed"; message?: string }
  | { type: "edit"; text: string }
  | { type: "send" }
  | { type: "cancel" }
  | { type: "reset" };

export const DEFAULT_VOICE_STATE: VoiceState = {
  phase: "idle",
  mode: "hold",
  partial: "",
  transcript: "",
  level: 0,
  error: null,
  errorKind: null,
};

const PERMISSION_DENIED =
  "Microphone access was denied. Allow the microphone for fabPlane in system settings, then try again.";
const UNAVAILABLE =
  "No speech provider is ready. Choose on-device speech, add a cloud key in Settings → Voice, or install the local model.";
const TRANSCRIBE_FAILED = "Could not transcribe that. Check the voice provider in Settings and try again.";

export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function reduceVoice(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "reset":
      return { ...DEFAULT_VOICE_STATE, mode: state.mode };
    case "start": {
      if (state.phase === "recording" || state.phase === "transcribing") return state;
      return {
        ...DEFAULT_VOICE_STATE,
        phase: "recording",
        mode: event.mode ?? state.mode,
      };
    }
    case "permission_denied":
      return {
        ...DEFAULT_VOICE_STATE,
        mode: state.mode,
        error: event.message?.trim() || PERMISSION_DENIED,
        errorKind: "permission_denied",
      };
    case "unavailable":
      return {
        ...DEFAULT_VOICE_STATE,
        mode: state.mode,
        error: event.message?.trim() || UNAVAILABLE,
        errorKind: "unavailable",
      };
    case "level":
      if (state.phase !== "recording") return state;
      return { ...state, level: clampLevel(event.value) };
    case "partial":
      if (state.phase !== "recording") return state;
      return { ...state, partial: event.text };
    case "stop": {
      if (state.phase !== "recording") return state;
      const draft = state.partial.trim();
      return {
        ...state,
        phase: "transcribing",
        level: 0,
        ...(draft ? { transcript: draft } : {}),
      };
    }
    case "transcript": {
      if (state.phase !== "transcribing" && state.phase !== "recording") return state;
      const text = event.text.trim();
      if (!text) {
        return {
          ...DEFAULT_VOICE_STATE,
          mode: state.mode,
          error: TRANSCRIBE_FAILED,
          errorKind: "transcribe_failed",
        };
      }
      return {
        ...state,
        phase: "editing",
        partial: "",
        transcript: text,
        level: 0,
        error: null,
        errorKind: null,
      };
    }
    case "transcribe_failed":
      if (state.phase !== "transcribing" && state.phase !== "recording") return state;
      return {
        ...DEFAULT_VOICE_STATE,
        mode: state.mode,
        error: event.message?.trim() || TRANSCRIBE_FAILED,
        errorKind: "transcribe_failed",
      };
    case "edit":
      if (state.phase !== "editing") return state;
      return { ...state, transcript: event.text };
    case "send":
      if (state.phase !== "editing") return state;
      if (!state.transcript.trim()) return state;
      return { ...state, phase: "sent", partial: "", level: 0 };
    case "cancel":
      if (state.phase === "idle" || state.phase === "sent" || state.phase === "cancelled") {
        return { ...DEFAULT_VOICE_STATE, mode: state.mode };
      }
      return {
        ...DEFAULT_VOICE_STATE,
        phase: "cancelled",
        mode: state.mode,
        errorKind: "aborted",
      };
  }
}

export function voiceDraft(state: VoiceState): string {
  if (state.phase === "recording") return state.partial;
  return state.transcript;
}

export function voiceBusy(state: VoiceState): boolean {
  return state.phase === "recording" || state.phase === "transcribing";
}
