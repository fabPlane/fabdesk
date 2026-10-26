/**
 * Hold-to-talk capture. The real phone uses expo-av when present; tests inject a recorder.
 * Audio stays in memory / a temp URI and is not copied into the project.
 */

export type VoiceRecorderPermission = "granted" | "denied" | "unavailable";

export interface VoiceRecording {
  uri: string;
  mime: string;
  read: () => Promise<Uint8Array>;
}

export interface VoiceRecorder {
  requestPermission(): Promise<VoiceRecorderPermission>;
  start(): Promise<void>;
  stop(): Promise<VoiceRecording | null>;
  cancel(): Promise<void>;
}

type ExpoAvModule = {
  Audio: {
    requestPermissionsAsync(): Promise<{ granted: boolean; status?: string }>;
    setAudioModeAsync(mode: Record<string, unknown>): Promise<void>;
    Recording: new () => ExpoRecording;
    RecordingOptionsPresets: { HIGH_QUALITY: Record<string, unknown> };
  };
};

type ExpoRecording = {
  prepareToRecordAsync(opts: Record<string, unknown>): Promise<void>;
  startAsync(): Promise<void>;
  stopAndUnloadAsync(): Promise<void>;
  getURI(): string | null;
};

type ExpoFs = {
  readAsStringAsync(uri: string, opts: { encoding: string }): Promise<string>;
  deleteAsync(uri: string, opts?: { idempotent?: boolean }): Promise<void>;
};

export function loadExpoAv(): ExpoAvModule | null {
  try {
    return require("expo-av") as ExpoAvModule;
  } catch {
    return null;
  }
}

export function createExpoAvRecorder(
  av: ExpoAvModule | null = loadExpoAv(),
  fs: ExpoFs | null = loadExpoFs(),
): VoiceRecorder | null {
  if (!av) return null;
  let recording: ExpoRecording | null = null;
  let uri: string | null = null;
  return {
    async requestPermission() {
      try {
        const res = await av.Audio.requestPermissionsAsync();
        return res.granted ? "granted" : "denied";
      } catch {
        return "unavailable";
      }
    },
    async start() {
      await av.Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const next = new av.Audio.Recording();
      await next.prepareToRecordAsync(av.Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await next.startAsync();
      recording = next;
      uri = null;
    },
    async stop() {
      const rec = recording;
      recording = null;
      if (!rec) return null;
      await rec.stopAndUnloadAsync().catch(() => undefined);
      uri = rec.getURI();
      if (!uri) return null;
      const captured = uri;
      return {
        uri: captured,
        mime: guessMime(captured),
        read: async () => {
          if (!fs) throw new Error("Cannot read the recording on this build.");
          const b64 = await fs.readAsStringAsync(captured, { encoding: "base64" });
          const bytes = Buffer.from(b64, "base64");
          await fs.deleteAsync(captured, { idempotent: true }).catch(() => undefined);
          return new Uint8Array(bytes);
        },
      };
    },
    async cancel() {
      const rec = recording;
      recording = null;
      if (rec) await rec.stopAndUnloadAsync().catch(() => undefined);
      const leftover = rec?.getURI() ?? uri;
      uri = null;
      if (leftover && fs) await fs.deleteAsync(leftover, { idempotent: true }).catch(() => undefined);
    },
  };
}

function loadExpoFs(): ExpoFs | null {
  try {
    return require("expo-file-system") as ExpoFs;
  } catch {
    return null;
  }
}

function guessMime(uri: string): string {
  if (uri.endsWith(".wav")) return "audio/wav";
  if (uri.endsWith(".m4a") || uri.endsWith(".mp4")) return "audio/mp4";
  if (uri.endsWith(".caf")) return "audio/x-caf";
  return "audio/m4a";
}

export function createFakeRecorder(
  opts: {
    permission?: VoiceRecorderPermission;
    bytes?: Uint8Array;
    mime?: string;
  } = {},
): VoiceRecorder & { started: boolean } {
  const rec = {
    started: false,
    async requestPermission() {
      return opts.permission ?? "granted";
    },
    async start() {
      rec.started = true;
    },
    async stop() {
      rec.started = false;
      const bytes = opts.bytes ?? new Uint8Array([1, 2, 3]);
      return {
        uri: "mem://clip",
        mime: opts.mime ?? "audio/wav",
        read: async () => bytes,
      };
    },
    async cancel() {
      rec.started = false;
    },
  };
  return rec;
}
