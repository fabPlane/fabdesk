import { expect, test } from "bun:test";
import type { SpeechStatus } from "@fabdesk/protocol";
import { availableSpeechBackend } from "./availability";

const status: SpeechStatus = {
  voice: { provider: "auto", language: "en", pushToTalkMode: "hold", pushToTalkShortcut: "Alt+Space" },
  active: "on_device", backends: [{ id: "on_device", ready: true }, { id: "local", ready: true }],
  cloudConfigured: false, cloudBaseUrl: null, localInstalled: true,
};
test("renderer availability overrides the daemon's assumed built-in engine", () => {
  expect(availableSpeechBackend("on_device", status, false)).toBeNull();
  expect(availableSpeechBackend("auto", status, false)).toBe("local");
  expect(availableSpeechBackend("auto", status, true)).toBe("on_device");
  expect(availableSpeechBackend("cloud", status, false)).toBeNull();
  expect(availableSpeechBackend("auto", { ...status, backends: [{ id: "on_device", ready: true }] }, false)).toBeNull();
});
