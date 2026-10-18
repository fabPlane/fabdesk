import {
  DEFAULT_VOICE_STATE,
  reduceVoice,
  voiceDraft,
  type VoiceEvent,
  type VoiceState,
} from "@fabdesk/client-core";
import type { CoreClient } from "@fabdesk/client-core";
import type { VoiceRecorder } from "./voice-record";

export interface MobileVoiceDeps {
  recorder: VoiceRecorder | null;
  client: Pick<CoreClient, "transcribeSpeech">;
  onDeviceTranscribe?: (recording: { uri: string; mime: string; read: () => Promise<Uint8Array> }) => Promise<string | null>;
  language?: string;
  /** Saved desktop provider. On-device cannot run on the daemon, so the phone falls back to auto. */
  provider?: "auto" | "on_device" | "cloud" | "local";
}

export interface MobileVoiceController {
  getState(): VoiceState;
  dispatch(event: VoiceEvent): VoiceState;
  holdStart(): Promise<void>;
  holdEnd(): Promise<string | null>;
  cancel(): Promise<void>;
}

export function createMobileVoice(deps: MobileVoiceDeps): MobileVoiceController {
  let state: VoiceState = { ...DEFAULT_VOICE_STATE, mode: "hold" };
  let starting: Promise<void> | null = null;
  const dispatch = (event: VoiceEvent): VoiceState => {
    state = reduceVoice(state, event);
    return state;
  };
  const holdStartInner = async () => {
    if (!deps.recorder) {
      dispatch({
        type: "unavailable",
        message: "This build cannot record audio. Update the phone app and try again.",
      });
      return;
    }
    const permission = await deps.recorder.requestPermission();
    if (permission === "denied") {
      dispatch({ type: "permission_denied" });
      return;
    }
    if (permission !== "granted") {
      dispatch({ type: "unavailable", message: "The microphone is not available." });
      return;
    }
    dispatch({ type: "start", mode: "hold" });
    try {
      await deps.recorder.start();
    } catch (e) {
      dispatch({
        type: "unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return {
    getState: () => state,
    dispatch,
    async holdStart() {
      starting = holdStartInner();
      await starting;
    },
    async holdEnd() {
      if (starting) await starting;
      if (state.phase !== "recording") return null;
      dispatch({ type: "stop" });
      const recording = deps.recorder ? await deps.recorder.stop() : null;
      if (!recording) {
        dispatch({ type: "transcribe_failed", message: "Nothing was recorded." });
        return null;
      }
      try {
        const onDevice = deps.onDeviceTranscribe ? await deps.onDeviceTranscribe(recording) : null;
        if (onDevice?.trim()) {
          dispatch({ type: "transcript", text: onDevice });
          return onDevice.trim();
        }
        const bytes = await recording.read();
        const copy = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(copy).set(bytes);
        const blob = new Blob([copy], { type: recording.mime });
        const coreProvider = deps.provider === "cloud" || deps.provider === "local" ? deps.provider : "auto";
        const result = await deps.client.transcribeSpeech({
          audio: blob,
          filename: "speech.m4a",
          ...(deps.language ? { language: deps.language } : {}),
          provider: coreProvider,
        });
        dispatch({ type: "transcript", text: result.text });
        return result.text;
      } catch (e) {
        dispatch({
          type: "transcribe_failed",
          message: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    },
    async cancel() {
      if (deps.recorder) await deps.recorder.cancel();
      dispatch({ type: "cancel" });
    },
  };
}

export function mobileVoiceDraft(state: VoiceState): string {
  return voiceDraft(state);
}
