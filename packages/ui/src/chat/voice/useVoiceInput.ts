import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings, SpeechStatus } from "@fabdesk/protocol";
import {
  DEFAULT_VOICE_STATE,
  matchVoiceShortcut,
  releasesVoiceShortcut,
  parseVoiceShortcut,
  reduceVoice,
  voiceBusy,
  voiceDraft,
  type VoiceEvent,
  type VoiceState,
} from "@fabdesk/client-core";
import type { CoreClient } from "@fabdesk/client-core";
import { createVoiceCapture, type VoiceCapture } from "./capture";
import { speechErrorMessage } from "./speech-error";
import { useNativeSpeech } from "./useNativeSpeech";
import { nativeSpeechWav } from "./native-wav";
import { availableSpeechBackend } from "./availability";
import { webSpeechAvailable } from "./web-speech";

export interface UseVoiceInputOptions {
  client: CoreClient;
  voice: Settings["voice"] | undefined;
  status: SpeechStatus | undefined;
  enabled?: boolean;
  onTranscript: (text: string) => void;
}

export function useVoiceInput({
  client,
  voice,
  status,
  enabled = true,
  onTranscript,
}: UseVoiceInputOptions) {
  const native = useNativeSpeech(voice?.language ?? "en");
  const nativeRequest = useRef<string | null>(null);
  const [state, setState] = useState<VoiceState>(DEFAULT_VOICE_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const captureRef = useRef<VoiceCapture | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const takeRef = useRef(0);

  const dispatch = useCallback((event: VoiceEvent) => {
    setState((prev) => reduceVoice(prev, event));
  }, []);

  const discard = useCallback(() => {
    if (nativeRequest.current) {
      void native.service?.cancel(nativeRequest.current).catch(() => {});
      nativeRequest.current = null;
    }
    captureRef.current?.cancel();
    captureRef.current = null;
  }, [native.service]);

  const deliverTranscript = useCallback((take: number, text: string) => {
    if (take !== takeRef.current) return false;
    dispatch({ type: "transcript", text });
    onTranscriptRef.current(text.trim());
    return true;
  }, [dispatch]);

  const stopAndTranscribe = useCallback(async () => {
    const take = takeRef.current;
    const capture = captureRef.current;
    captureRef.current = null;
    dispatch({ type: "stop" });
    const result = capture ? await capture.stop() : null;
    if (take !== takeRef.current) return;
    const preferOnDevice = shouldUseOnDevice(voice?.provider ?? "auto", !!result?.onDeviceText);
    try {
      if (preferOnDevice && result?.onDeviceText.trim()) {
        deliverTranscript(take, result.onDeviceText);
        return;
      }
      if (result && result.blob.size > 0 && native.available && native.service &&
          (voice?.provider === "on_device" || !voice?.provider || voice.provider === "auto")) {
        const id = crypto.randomUUID();
        nativeRequest.current = id;
        try {
          const audio = await nativeSpeechWav(result.blob);
          if (take !== takeRef.current) return;
          const transcript = await native.service.transcribe({ id, audio, language: voice?.language || "en" });
          if (take !== takeRef.current) return;
          deliverTranscript(take, transcript.text);
          return;
        } finally { if (nativeRequest.current === id) nativeRequest.current = null; }
      }
      if (result && result.blob.size > 0 && canUseCore(voice?.provider ?? "auto", status)) {
        const transcript = await client.transcribeSpeech({
          audio: result.blob,
          filename: filenameFor(result.mime),
          ...(voice?.language ? { language: voice.language } : {}),
          ...(voice?.provider && voice.provider !== "auto" && voice.provider !== "on_device"
            ? { provider: voice.provider }
            : {}),
        });
        if (take !== takeRef.current) return;
        deliverTranscript(take, transcript.text);
        return;
      }
      if (result?.onDeviceText.trim()) {
        deliverTranscript(take, result.onDeviceText);
        return;
      }
      if (take !== takeRef.current) return;
      dispatch({
        type: "unavailable",
        message: (voice?.provider === "on_device" || !voice?.provider || voice.provider === "auto") && native.message
          ? native.message : statusUnavailableMessage(status, voice?.provider ?? "auto"),
      });
    } catch (e) {
      if (take !== takeRef.current) return;
      dispatch({
        type: "transcribe_failed",
        message: speechErrorMessage(e),
      });
    }
  }, [client, deliverTranscript, dispatch, status, voice, native.available, native.service, native.message]);

  const start = useCallback(async () => {
    if (!enabled || voiceBusy(stateRef.current)) return;
    if (!canStart(voice?.provider ?? "auto", status, native.available)) {
      dispatch({
        type: "unavailable",
        message: (voice?.provider === "on_device" || !voice?.provider || voice.provider === "auto") && native.message
          ? native.message : statusUnavailableMessage(status, voice?.provider ?? "auto"),
      });
      return;
    }
    takeRef.current += 1;
    dispatch({ type: "start", mode: voice?.pushToTalkMode ?? "hold" });
    const capture = createVoiceCapture({
      onLevel: (value) => dispatch({ type: "level", value }),
      onPartial: (text) => dispatch({ type: "partial", text }),
      onError: (err) => {
        discard();
        dispatch({ type: err.type, message: err.message });
      },
    });
    captureRef.current = capture;
    await capture.start(voice?.language ?? "en");
  }, [discard, dispatch, enabled, status, voice, native.available, native.message]);

  const cancel = useCallback(() => {
    takeRef.current += 1;
    discard();
    dispatch({ type: "cancel" });
  }, [discard, dispatch]);

  const reset = useCallback(() => {
    discard();
    dispatch({ type: "reset" });
  }, [discard, dispatch]);

  const toggle = useCallback(() => {
    if (stateRef.current.phase === "recording") void stopAndTranscribe();
    else void start();
  }, [start, stopAndTranscribe]);

  useEffect(() => {
    if (!enabled) return;
    const shortcut = parseVoiceShortcut(voice?.pushToTalkShortcut);
    const mode = voice?.pushToTalkMode ?? "hold";
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (stateRef.current.phase !== "idle") {
          e.preventDefault();
          cancel();
        }
        return;
      }
      if (e.repeat) return;
      if (!matchVoiceShortcut(e, shortcut)) return;
      e.preventDefault();
      if (mode === "toggle") toggle();
      else if (stateRef.current.phase !== "recording") void start();
    };
    const onUp = (e: KeyboardEvent) => {
      if (mode !== "hold" || e.repeat) return;
      if (!releasesVoiceShortcut(e, shortcut)) return;
      if (stateRef.current.phase === "recording") {
        e.preventDefault();
        void stopAndTranscribe();
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [cancel, enabled, start, stopAndTranscribe, toggle, voice]);

  useEffect(() => () => discard(), [discard]);

  return {
    state,
    draft: voiceDraft(state),
    start,
    stop: stopAndTranscribe,
    cancel,
    reset,
    toggle,
    holdStart: start,
    holdEnd: () => {
      if (stateRef.current.phase === "recording") void stopAndTranscribe();
    },
  };
}

export function canStart(provider: Settings["voice"]["provider"], status: SpeechStatus | undefined, nativeAvailable = false): boolean {
  return availableSpeechBackend(provider, status, webSpeechAvailable() || nativeAvailable) !== null;
}

export function canUseCore(provider: Settings["voice"]["provider"], status: SpeechStatus | undefined): boolean {
  if (provider === "on_device") return false;
  if (provider === "cloud" || provider === "local") return true;
  return status?.active === "cloud" || status?.active === "local";
}

export function shouldUseOnDevice(provider: Settings["voice"]["provider"], hasText: boolean): boolean {
  if (!hasText) return false;
  return provider === "on_device" || provider === "auto";
}

export function statusUnavailableMessage(
  status: SpeechStatus | undefined,
  provider: Settings["voice"]["provider"],
): string {
  if (provider === "cloud") {
    return status?.backends.find((b) => b.id === "cloud")?.message
      ?? "No cloud speech key. Add one in Settings → Voice.";
  }
  if (provider === "local") {
    return status?.backends.find((b) => b.id === "local")?.message
      ?? "The local speech model is not installed. Download it in Settings → Voice.";
  }
  if (provider === "on_device" && !webSpeechAvailable()) {
    return "Built-in speech recognition is not available in this app. Choose Cloud or Local model in Settings → Voice.";
  }
  return "Speech recognition needs setup. Add a cloud key or configure a local speech engine in Settings → Voice.";
}

function filenameFor(mime: string): string {
  if (mime.includes("wav")) return "speech.wav";
  if (mime.includes("mp4")) return "speech.m4a";
  return "speech.webm";
}
