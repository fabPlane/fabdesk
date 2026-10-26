import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VOICE_STATE,
  reduceVoice,
  voiceBusy,
  voiceDraft,
  VOICE_PHASES,
} from "./composer-state";

describe("voice composer state machine", () => {
  test("lists the phases a first version has to cover", () => {
    expect(VOICE_PHASES).toEqual([
      "idle",
      "recording",
      "transcribing",
      "editing",
      "sent",
      "cancelled",
    ]);
  });

  test("idle → recording → transcribing → editing → sent", () => {
    let s = reduceVoice(DEFAULT_VOICE_STATE, { type: "start", mode: "hold" });
    expect(s.phase).toBe("recording");
    expect(voiceBusy(s)).toBe(true);
    s = reduceVoice(s, { type: "partial", text: "add a USB-C" });
    expect(voiceDraft(s)).toBe("add a USB-C");
    s = reduceVoice(s, { type: "level", value: 1.4 });
    expect(s.level).toBe(1);
    s = reduceVoice(s, { type: "stop" });
    expect(s.phase).toBe("transcribing");
    expect(s.transcript).toBe("add a USB-C");
    s = reduceVoice(s, { type: "transcript", text: "  add a USB-C jack  " });
    expect(s.phase).toBe("editing");
    expect(s.transcript).toBe("add a USB-C jack");
    s = reduceVoice(s, { type: "edit", text: "add a USB-C jack and run DRC" });
    s = reduceVoice(s, { type: "send" });
    expect(s.phase).toBe("sent");
    s = reduceVoice(s, { type: "reset" });
    expect(s.phase).toBe("idle");
    expect(s.transcript).toBe("");
  });

  test("Esc cancels from recording, transcribing, and editing", () => {
    const recording = reduceVoice(DEFAULT_VOICE_STATE, { type: "start" });
    expect(reduceVoice(recording, { type: "cancel" }).phase).toBe("cancelled");
    const transcribing = reduceVoice(recording, { type: "stop" });
    expect(reduceVoice(transcribing, { type: "cancel" }).phase).toBe("cancelled");
    const editing = reduceVoice(transcribing, { type: "transcript", text: "hello" });
    expect(reduceVoice(editing, { type: "cancel" })).toMatchObject({
      phase: "cancelled",
      transcript: "",
      errorKind: "aborted",
    });
  });

  test("permission denied and a missing provider stay idle with a clear error", () => {
    const denied = reduceVoice(DEFAULT_VOICE_STATE, { type: "permission_denied" });
    expect(denied.phase).toBe("idle");
    expect(denied.errorKind).toBe("permission_denied");
    expect(denied.error).toMatch(/denied/i);
    const missing = reduceVoice(DEFAULT_VOICE_STATE, { type: "unavailable" });
    expect(missing.errorKind).toBe("unavailable");
    expect(missing.error).toMatch(/No speech provider/i);
  });

  test("an empty or failed transcript does not reach editing", () => {
    const transcribing = reduceVoice(
      reduceVoice(DEFAULT_VOICE_STATE, { type: "start" }),
      { type: "stop" },
    );
    expect(reduceVoice(transcribing, { type: "transcript", text: "   " }).errorKind).toBe(
      "transcribe_failed",
    );
    expect(reduceVoice(transcribing, { type: "transcribe_failed" }).phase).toBe("idle");
  });

  test("ignores events that do not belong to the current phase", () => {
    expect(reduceVoice(DEFAULT_VOICE_STATE, { type: "stop" }).phase).toBe("idle");
    expect(reduceVoice(DEFAULT_VOICE_STATE, { type: "send" }).phase).toBe("idle");
    expect(reduceVoice(DEFAULT_VOICE_STATE, { type: "edit", text: "x" }).transcript).toBe("");
    const recording = reduceVoice(DEFAULT_VOICE_STATE, { type: "start" });
    expect(reduceVoice(recording, { type: "start" }).phase).toBe("recording");
    expect(reduceVoice(recording, { type: "send" }).phase).toBe("recording");
  });
});
