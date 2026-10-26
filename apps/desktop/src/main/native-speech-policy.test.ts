import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { validateNativeSpeechRequest, withNativeRecording } from "./native-speech-policy";
import { pcmWav } from "../../../../packages/ui/src/chat/voice/native-wav";

test("native IPC accepts audio bytes, never arbitrary file paths", () => {
  const audio = pcmWav(new Float32Array([0, 0.5, -0.5]), 16000);
  expect(validateNativeSpeechRequest({ id: "take-1", language: "en-US", audio }).audio).toBe(audio);
  expect(() => validateNativeSpeechRequest({ id: "take-1", language: "en", audio: "/etc/passwd" })).toThrow("WAV");
  expect(() => validateNativeSpeechRequest({ id: "../../file", language: "en", audio })).toThrow("request");
  expect(() => validateNativeSpeechRequest({ id: "take-1", language: "../file", audio })).toThrow("language");
  expect(() => validateNativeSpeechRequest({ id: "take-1", language: "en", audio: new ArrayBuffer(50) })).toThrow("WAV");
  expect(() => validateNativeSpeechRequest({ id: "take-1", language: "en", audio: new ArrayBuffer(26 * 1024 * 1024) })).toThrow("25 MB");
});

test("temporary speech audio is removed after success, cancellation and errors", async () => {
  for (const fail of [false, true]) {
    let path = "";
    const work = withNativeRecording(pcmWav(new Float32Array([0]), 16000), async (file) => {
      path = file;
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      if (fail) throw new Error("cancelled");
      return "test transcript";
    });
    if (fail) await expect(work).rejects.toThrow("cancelled");
    else expect(await work).toBe("test transcript");
    expect(await Bun.file(path).exists()).toBe(false);
  }
});
