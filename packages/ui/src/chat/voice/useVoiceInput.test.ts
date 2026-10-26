import { describe, expect, test } from "bun:test";
import type { SpeechStatus } from "@fabdesk/protocol";
import { canStart, canUseCore, shouldUseOnDevice, statusUnavailableMessage } from "./useVoiceInput";

const status = (over: Partial<SpeechStatus> = {}): SpeechStatus => ({
  voice: {
    provider: "auto",
    language: "en",
    pushToTalkMode: "hold",
    pushToTalkShortcut: "Alt+Space",
  },
  active: "cloud",
  backends: [
    { id: "on_device", ready: true },
    { id: "cloud", ready: true },
    { id: "local", ready: false, message: "not installed" },
  ],
  cloudConfigured: true,
  cloudBaseUrl: null,
  localInstalled: false,
  ...over,
});

describe("voice input policy", () => {
  test("auto uses on-device text when the engine produced some", () => {
    expect(shouldUseOnDevice("auto", true)).toBe(true);
    expect(shouldUseOnDevice("cloud", true)).toBe(false);
    expect(shouldUseOnDevice("auto", false)).toBe(false);
  });

  test("cloud / local go through the daemon; on-device does not", () => {
    expect(canUseCore("cloud", status())).toBe(true);
    expect(canUseCore("on_device", status())).toBe(false);
    expect(canUseCore("auto", status({ active: "on_device" }))).toBe(false);
    expect(canUseCore("auto", status({ active: "cloud" }))).toBe(true);
  });

  test("start is refused when the chosen backend is missing", () => {
    expect(canStart("cloud", status({ backends: [{ id: "cloud", ready: false }] }))).toBe(false);
    expect(canStart("local", status())).toBe(false);
    expect(canStart("auto", status({ active: "on_device", backends: [{ id: "on_device", ready: true }] }))).toBe(false);
    expect(statusUnavailableMessage(status(), "on_device")).toContain("not available in this app");
    expect(canStart("on_device", status(), true)).toBe(true);
    expect(canStart("auto", undefined, true)).toBe(true);
    expect(statusUnavailableMessage(status(), "local")).toMatch(/not installed/i);
  });
});
