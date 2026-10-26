import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function validateNativeSpeechRequest(raw: unknown): { id: string; language: string; audio: ArrayBuffer } {
  const request = raw as { id?: unknown; language?: unknown; audio?: unknown } | null;
  if (!request || typeof request.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)) throw new Error("Invalid speech request.");
  if (typeof request.language !== "string" || !/^[a-zA-Z0-9_-]{2,40}$/.test(request.language)) throw new Error("Invalid speech language.");
  if (!(request.audio instanceof ArrayBuffer) || request.audio.byteLength < 44 || request.audio.byteLength > 25 * 1024 * 1024) throw new Error("Speech audio must be a WAV recording under 25 MB.");
  const bytes = new Uint8Array(request.audio);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") throw new Error("Speech audio must be a WAV recording.");
  return { id: request.id, language: request.language, audio: request.audio };
}

/** Recordings are private and survive only for the lifetime of one recognition task. */
export async function withNativeRecording<T>(audio: ArrayBuffer, recognize: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-speech-"));
  try {
    const path = join(directory, "recording.wav");
    await writeFile(path, new Uint8Array(audio), { mode: 0o600 });
    return await recognize(path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
