import { describe, expect, test } from "bun:test";
import { createFakeRecorder } from "./voice-record";
import { createMobileVoice } from "./voice-input";

describe("mobile hold-to-talk", () => {
  test("records, transcribes on the paired desktop, and yields a normal message", async () => {
    const recorder = createFakeRecorder({ bytes: new Uint8Array([9, 8, 7]) });
    let sent = 0;
    const voice = createMobileVoice({
      recorder,
      client: {
        transcribeSpeech: async ({ audio }) => {
          sent = await audio.arrayBuffer().then((b) => b.byteLength);
          return { text: "add a USB-C jack", backend: "cloud" };
        },
      },
    });
    await voice.holdStart();
    expect(voice.getState().phase).toBe("recording");
    expect(recorder.started).toBe(true);
    const text = await voice.holdEnd();
    expect(text).toBe("add a USB-C jack");
    expect(sent).toBe(3);
    expect(voice.getState().phase).toBe("editing");
  });

  test("permission denied stays idle with a clear error", async () => {
    const voice = createMobileVoice({
      recorder: createFakeRecorder({ permission: "denied" }),
      client: { transcribeSpeech: async () => ({ text: "nope", backend: "cloud" }) },
    });
    await voice.holdStart();
    expect(voice.getState()).toMatchObject({ phase: "idle", errorKind: "permission_denied" });
  });

  test("prefers an on-device transcript when one is available", async () => {
    let coreCalls = 0;
    const voice = createMobileVoice({
      recorder: createFakeRecorder(),
      client: {
        transcribeSpeech: async () => {
          coreCalls += 1;
          return { text: "from desktop", backend: "cloud" };
        },
      },
      onDeviceTranscribe: async () => "from the phone",
    });
    await voice.holdStart();
    expect(await voice.holdEnd()).toBe("from the phone");
    expect(coreCalls).toBe(0);
  });

  test("cancel drops the take", async () => {
    const recorder = createFakeRecorder();
    const voice = createMobileVoice({
      recorder,
      client: { transcribeSpeech: async () => ({ text: "x", backend: "cloud" }) },
    });
    await voice.holdStart();
    await voice.cancel();
    expect(voice.getState().phase).toBe("cancelled");
    expect(recorder.started).toBe(false);
  });
});
