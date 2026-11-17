import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEME_BACKGROUNDS } from "../../../../packages/ui/src/theme/resolve";
import { readCachedThemeId, resolveWindowTheme, titleBarOverlayFor, TITLE_BAR_HEIGHT, writeCachedThemeId } from "./window-theme";

function tmpUserData(): string {
  return mkdtempSync(join(tmpdir(), "fabdesk-theme-"));
}

describe("Windows title bar overlay", () => {
  test("native chrome keeps its height independent of workspace zoom", () => {
    for (const theme of ["fabplane-dark", "fabplane-light", "plain-dark", "plain-light"] as const) {
      expect(titleBarOverlayFor(theme).height).toBe(TITLE_BAR_HEIGHT - 1);
    }
  });

  test("theme changes preserve fixed geometry and update native colours", () => {
    const dark = titleBarOverlayFor("fabplane-dark");
    const light = titleBarOverlayFor("fabplane-light");
    expect(light.height).toBe(dark.height);
    expect(light.color).toBe("#00000000");
    expect(dark.color).toBe("#00000000");
    expect(light.symbolColor).not.toBe(dark.symbolColor);
  });
});

describe("resolveWindowTheme", () => {
  test("uses the cached Appearance id for background and locks nativeTheme", () => {
    const dir = tmpUserData();
    writeCachedThemeId(dir, "fabplane-light");
    const light = resolveWindowTheme(dir, true);
    expect(light.themeId).toBe("fabplane-light");
    expect(light.backgroundColor).toBe(THEME_BACKGROUNDS["fabplane-light"]);
    expect(light.themeSource).toBe("light");

    writeCachedThemeId(dir, "plain-dark");
    const dark = resolveWindowTheme(dir, false);
    expect(dark.themeId).toBe("plain-dark");
    expect(dark.backgroundColor).toBe(THEME_BACKGROUNDS["plain-dark"]);
    expect(dark.themeSource).toBe("dark");
  });

  test("follows the OS when no cache exists", () => {
    const dir = tmpUserData();
    expect(readCachedThemeId(dir)).toBeNull();
    expect(resolveWindowTheme(dir, true)).toEqual({
      themeId: "fabplane-dark",
      backgroundColor: THEME_BACKGROUNDS["fabplane-dark"],
      themeSource: "system",
    });
    expect(resolveWindowTheme(dir, false)).toEqual({
      themeId: "fabplane-light",
      backgroundColor: THEME_BACKGROUNDS["fabplane-light"],
      themeSource: "system",
    });
  });

  test("ignores a corrupt cache file", () => {
    const dir = tmpUserData();
    writeFileSync(join(dir, "theme.json"), "not-json");
    expect(readCachedThemeId(dir)).toBeNull();
    expect(resolveWindowTheme(dir, true).themeSource).toBe("system");
  });
});
