import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairClaimResult, PairStartResult, Settings, SpeechStatus } from "@fabdesk/protocol";
import type { AgentEvent, AgentRun } from "@fabdesk/agents";
import type { CoreServices } from "@fabdesk/tools";
import { createFakeSpeechProvider, createSpeechService } from "../src/speech";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

const REMOTE = { enabled: true, host: "127.0.0.1", port: 47841 };
const remoteUrl = `http://${REMOTE.host}:${REMOTE.port}`;

let daemon: Daemon;
let home: string;
const transcribed: Array<{ bytes: number; language: string }> = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-speech-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "speech-test-token-0123456789";
  delete process.env["FABDESK_SPEECH_API_KEY"];
  const cloud = createFakeSpeechProvider({
    id: "cloud",
    text: "add a USB-C jack and run DRC",
    onTranscribe: (input) =>
      transcribed.push({ bytes: input.audio.bytes.byteLength, language: input.language }),
  });
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    quiet: true,
    watchProjects: false,
    speech: createSpeechService({
      home,
      settings: {
        get: () => {
          try {
            return daemon.store.settings.get();
          } catch {
            return (
              {
                voice: {
                  provider: "auto",
                  language: "en",
                  pushToTalkMode: "hold",
                  pushToTalkShortcut: "Alt+Space",
                },
              } as Settings
            );
          }
        },
        readRaw: (key) => daemon?.store.settings.readRaw(key),
        writeRaw: (key, value) => daemon.store.settings.writeRaw(key, value),
        patch: (p) => daemon.store.settings.patch(p),
        coreId: () => daemon.store.settings.coreId(),
      } as never,
      cloud,
      local: createFakeSpeechProvider({ id: "local", ready: false, message: "not installed" }),
    }),
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "public",
      }) as unknown as CoreServices,
    adapters: {
      claude: {
        id: "claude",
        run: (): AgentRun => ({
          events: (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "text", delta: "ok" };
            yield { type: "done", exitCode: 0 };
          })(),
          abort() {},
        }),
      },
    },
    doctor: async () => ({
      version: "t",
      channel: "public",
      bun: Bun.version,
      platform: "test",
      kicad: { found: false },
      ngspice: { found: false },
      routers: [],
      agents: [],
      warnings: [],
    }),
  });
});

afterAll(async () => {
  await daemon.close("tests done");
});

const H = () => ({ authorization: `Bearer ${daemon.token}` });
const local = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, { ...init, headers: { ...H(), ...(init.headers ?? {}) } });

async function pairPhone(): Promise<string> {
  await local("/settings", { method: "PATCH", body: JSON.stringify({ remote: REMOTE }), headers: { "content-type": "application/json" } });
  const start = (await (
    await local("/v1/devices/pair/start", { method: "POST" })
  ).json()) as PairStartResult;
  const claim = (await (
    await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: start.pairingToken, label: "Voice phone", platform: "ios" }),
    })
  ).json()) as PairClaimResult;
  return claim.deviceToken;
}

describe("speech HTTP", () => {
  test("status is authenticated and never includes a cloud key", async () => {
    expect((await fetch(`${daemon.url}/v1/speech/status`)).status).toBe(401);
    const res = await local("/v1/speech/status");
    expect(res.status).toBe(200);
    const status = (await res.json()) as SpeechStatus;
    expect(status.voice.provider).toBe("auto");
    expect(status.active).toBe("cloud");
    expect(status.cloudConfigured).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/sk-|apiKey|secret/i);
  });

  test("PATCH /settings merges voice fields without wiping the rest", async () => {
    const res = await local("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: { language: "de" } }),
    });
    expect(res.status).toBe(200);
    const settings = (await res.json()) as Settings;
    expect(settings.voice).toMatchObject({
      language: "de",
      provider: "auto",
      pushToTalkMode: "hold",
      pushToTalkShortcut: "Alt+Space",
    });
    await local("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: { language: "en" } }),
    });
  });

  test("the daemon token can transcribe audio", async () => {
    transcribed.length = 0;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "clip.webm");
    form.append("language", "en");
    const res = await fetch(`${daemon.url}/v1/speech/transcribe`, {
      method: "POST",
      headers: H(),
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      text: "add a USB-C jack and run DRC",
      backend: "cloud",
    });
    expect(transcribed).toEqual([{ bytes: 4, language: "en" }]);
  });

  test("a paired phone can transcribe and cannot write the cloud key", async () => {
    const token = await pairPhone();
    const asDevice = { authorization: `Bearer ${token}` };
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([9, 8, 7])], { type: "audio/wav" }), "clip.wav");
    const ok = await fetch(`${remoteUrl}/v1/speech/transcribe`, {
      method: "POST",
      headers: asDevice,
      body: form,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { text: string }).text).toContain("USB-C");

    const put = await fetch(`${remoteUrl}/v1/speech/cloud`, {
      method: "PUT",
      headers: { ...asDevice, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-should-not-store" }),
    });
    expect(put.status).toBe(404);

    const putLocal = await fetch(`${daemon.url}/v1/speech/cloud`, {
      method: "PUT",
      headers: { ...asDevice, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-should-not-store" }),
    });
    expect(putLocal.status).toBe(403);
    const status = (await (await local("/v1/speech/status")).json()) as SpeechStatus;
    expect(status.cloudConfigured).toBe(false);
  });

  test("missing audio and a missing token are rejected", async () => {
    expect((await fetch(`${daemon.url}/v1/speech/transcribe`, { method: "POST", headers: H() })).status).toBe(400);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1])], { type: "audio/webm" }), "clip.webm");
    expect(
      (await fetch(`${daemon.url}/v1/speech/transcribe`, { method: "POST", body: form })).status,
    ).toBe(401);
  });

  test("the desktop can store and clear a cloud key without returning it", async () => {
    const put = await local("/v1/speech/cloud", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-key", baseUrl: "https://stt.example/v1" }),
    });
    expect(put.status).toBe(200);
    const stored = (await put.json()) as SpeechStatus;
    expect(stored.cloudConfigured).toBe(true);
    expect(stored.cloudBaseUrl).toBe("https://stt.example/v1");
    expect(JSON.stringify(stored)).not.toContain("sk-test-key");
    const cleared = (await (await local("/v1/speech/cloud", { method: "DELETE" })).json()) as SpeechStatus;
    expect(cleared.cloudConfigured).toBe(false);
  });
});
