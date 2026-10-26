import { expect, test } from "bun:test";
import { speechErrorMessage } from "./speech-error";
test("speech failures show setup guidance without Electron's internal method name", () => {
  expect(speechErrorMessage(new Error("Error invoking remote method 'fabdesk:speech-transcribe': Error: Siri and Dictation are disabled"))).toBe("macOS Dictation is turned off. Enable Dictation in System Settings → Keyboard, then try again.");
  expect(speechErrorMessage(new Error("Error invoking remote method 'fabdesk:speech-transcribe': Error: No speech was detected."))).toBe("No speech was detected.");
  expect(speechErrorMessage(new Error("The cloud speech key was rejected."))).toBe("The cloud speech key was rejected.");
});
