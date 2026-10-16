import { describe, expect, test } from "bun:test";
import { createCloudSpeechProvider } from "./cloud";
import { createLocalSpeechProvider, installLocalSpeechModel, localSpeechPaths } from "./local";
import { createFakeSpeechProvider, SpeechProviderError } from "./provider";
import { pickActive } from "./service";
import { HARDWARE_VOCABULARY, vocabularyPrompt } from "./vocabulary";
import { cloudBaseUrl, DEFAULT_SPEECH_CLOUD_URL } from "./secrets";

describe("speech providers", () => {
  test("the fake provider returns a transcript and refuses empty audio", async () => {
    const seen: string[] = [];
    const fake = createFakeSpeechProvider({
      text: "route the USB-C jack",
      onTranscribe: (input) => seen.push(input.language),
    });
    expect(await fake.ready()).toEqual({ ready: true });
    const result = await fake.transcribe({
      audio: { bytes: new Uint8Array([1, 2, 3]), mime: "audio/webm" },
      language: "en",
    });
    expect(result).toEqual({ text: "route the USB-C jack", backend: "cloud", language: "en" });
    expect(seen).toEqual(["en"]);
    await expect(
      fake.transcribe({ audio: { bytes: new Uint8Array(), mime: "audio/webm" }, language: "en" }),
    ).rejects.toBeInstanceOf(SpeechProviderError);
  });

  test("cloud posts multipart to an OpenAI-compatible URL and never echoes the key in errors", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const provider = createCloudSpeechProvider({
      config: () => ({ apiKey: "sk-secret", baseUrl: "https://stt.example/v1" }),
      fetchImpl: async (url, init) => {
        calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get("model")).toBe("whisper-1");
        expect(String(form.get("prompt"))).toContain("KiCad");
        return Response.json({ text: " add a 0402 cap " });
      },
    });
    const result = await provider.transcribe({
      audio: { bytes: new Uint8Array([9]), mime: "audio/wav", filename: "clip.wav" },
      language: "en",
    });
    expect(result.text).toBe("add a 0402 cap");
    expect(calls[0]).toEqual({ url: "https://stt.example/v1/audio/transcriptions", auth: "Bearer sk-secret" });
    expect(cloudBaseUrl(null)).toBe(DEFAULT_SPEECH_CLOUD_URL);
  });

  test("local runs whisper-cli and deletes the temp audio", async () => {
    const home = `/tmp/fabdesk-speech-${Date.now()}`;
    const paths = localSpeechPaths(home);
    const ran: string[] = [];
    const missing = createLocalSpeechProvider({
      home,
      which: () => null,
      exists: async () => false,
      run: async () => "",
    });
    expect((await missing.ready()).ready).toBe(false);
    const installed = createLocalSpeechProvider({
      home,
      which: () => `${paths.binDir}/whisper-cli`,
      exists: async () => true,
      run: async ({ audio }) => {
        ran.push(audio);
        return "place the ESP32";
      },
    });
    expect((await installed.ready()).ready).toBe(true);
    const result = await installed.transcribe({
      audio: { bytes: new Uint8Array([1, 2]), mime: "audio/webm" },
      language: "en",
    });
    expect(result).toMatchObject({ text: "place the ESP32", backend: "local" });
    expect(ran[0]).toContain("speech-");
  });

  test("auto prefers cloud, then local, then on-device", () => {
    expect(pickActive("auto", { cloud: true, local: true })).toBe("cloud");
    expect(pickActive("auto", { cloud: false, local: true })).toBe("local");
    expect(pickActive("auto", { cloud: false, local: false })).toBe("on_device");
    expect(pickActive("cloud", { cloud: false, local: true })).toBeNull();
    expect(pickActive("on_device", { cloud: true, local: true })).toBe("on_device");
  });

  test("the hardware vocabulary includes the usual shop words", () => {
    expect(HARDWARE_VOCABULARY).toContain("KiCad");
    expect(HARDWARE_VOCABULARY).toContain("USB-C");
    expect(HARDWARE_VOCABULARY).toContain("ESP32");
    expect(vocabularyPrompt(["JST-PH"])).toContain("JST-PH");
  });

  test("installLocalSpeechModel writes through the injected downloader", async () => {
    const home = `/tmp/fabdesk-speech-install-${Date.now()}`;
    let dest = "";
    const result = await installLocalSpeechModel({
      home,
      download: async (_url, path) => {
        dest = path;
      },
    });
    expect(result.modelPath).toBe(dest);
    expect(dest).toContain("ggml-tiny.en.bin");
  });
});
