import { describe, expect, test } from "bun:test";
import { isRevealDevOptionsShortcut, showDevSignInOptions, type RevealKey } from "./dev-options";

const key = (over: Partial<RevealKey>): RevealKey => ({ key: "l", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("isRevealDevOptionsShortcut", () => {
  test("Cmd+L on macOS, not Ctrl+L", () => {
    expect(isRevealDevOptionsShortcut(key({ metaKey: true }), "darwin")).toBe(true);
    expect(isRevealDevOptionsShortcut(key({ key: "L", metaKey: true }), "darwin")).toBe(true);
    expect(isRevealDevOptionsShortcut(key({ ctrlKey: true }), "darwin")).toBe(false);
  });

  test("Ctrl+L on Windows and Linux, not Meta+L", () => {
    for (const platform of ["win32", "linux"]) {
      expect(isRevealDevOptionsShortcut(key({ ctrlKey: true }), platform)).toBe(true);
      expect(isRevealDevOptionsShortcut(key({ metaKey: true }), platform)).toBe(false);
    }
  });

  test("ignores other keys and extra modifiers", () => {
    expect(isRevealDevOptionsShortcut(key({ key: "k", metaKey: true }), "darwin")).toBe(false);
    expect(isRevealDevOptionsShortcut(key({ metaKey: true, shiftKey: true }), "darwin")).toBe(false);
    expect(isRevealDevOptionsShortcut(key({ metaKey: true, altKey: true }), "darwin")).toBe(false);
    expect(isRevealDevOptionsShortcut(key({}), "darwin")).toBe(false);
  });
});

describe("showDevSignInOptions", () => {
  test("hidden by default outside dev builds", () => {
    expect(showDevSignInOptions({ devBuild: false, revealed: false })).toBe(false);
    expect(showDevSignInOptions({ devBuild: undefined, revealed: false })).toBe(false);
  });

  test("shown up front in dev builds", () => {
    expect(showDevSignInOptions({ devBuild: true, revealed: false })).toBe(true);
  });

  test("the reveal also works in a packaged build, so local mode stays reachable there", () => {
    expect(showDevSignInOptions({ devBuild: false, revealed: true })).toBe(true);
    expect(showDevSignInOptions({ devBuild: undefined, revealed: true })).toBe(true);
  });
});
