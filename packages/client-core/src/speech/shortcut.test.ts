import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VOICE_SHORTCUT,
  formatVoiceShortcut,
  matchVoiceShortcut,
  parseVoiceShortcut,
} from "./shortcut";

describe("voice shortcut", () => {
  test("parses Alt+Space and ignores junk", () => {
    expect(parseVoiceShortcut("Alt+Space")).toEqual(DEFAULT_VOICE_SHORTCUT);
    expect(parseVoiceShortcut("option+space")).toEqual(DEFAULT_VOICE_SHORTCUT);
    expect(parseVoiceShortcut("Ctrl+Shift+M")).toEqual({
      key: "m",
      alt: false,
      ctrl: true,
      meta: false,
      shift: true,
    });
    expect(parseVoiceShortcut("")).toEqual(DEFAULT_VOICE_SHORTCUT);
    expect(parseVoiceShortcut("Alt+")).toEqual(DEFAULT_VOICE_SHORTCUT);
  });

  test("formats for the host platform", () => {
    expect(formatVoiceShortcut(DEFAULT_VOICE_SHORTCUT, "linux")).toBe("Alt+Space");
    expect(formatVoiceShortcut(DEFAULT_VOICE_SHORTCUT, "darwin")).toBe("⌥Space");
  });

  test("matches a keyboard event", () => {
    expect(
      matchVoiceShortcut(
        { key: " ", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false },
        DEFAULT_VOICE_SHORTCUT,
      ),
    ).toBe(true);
    expect(
      matchVoiceShortcut(
        { key: " ", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
        DEFAULT_VOICE_SHORTCUT,
      ),
    ).toBe(false);
  });
});

test("push-to-talk stops when Option is released before Space", async () => {
  const { releasesVoiceShortcut } = await import("./shortcut");
  const shortcut = parseVoiceShortcut("Alt+Space");
  expect(releasesVoiceShortcut({ key: "Alt" }, shortcut)).toBe(true);
  expect(releasesVoiceShortcut({ key: " " }, shortcut)).toBe(true);
  expect(releasesVoiceShortcut({ key: "a" }, shortcut)).toBe(false);
});

test("macOS Option+Space matches its non-breaking-space key value", () => {
  const shortcut = parseVoiceShortcut("Alt+Space");
  expect(matchVoiceShortcut({ key: "\u00a0", code: "Space", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, shortcut)).toBe(true);
  expect(matchVoiceShortcut({ key: "\u00a0", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }, shortcut)).toBe(true);
});
