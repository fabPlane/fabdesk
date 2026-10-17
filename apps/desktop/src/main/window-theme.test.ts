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
  test("tracks zoom in, zoom out and reset without covering the divider", () => {
    // Includes the user's 57.87% zoom and repeated returns to 100%.
    for (const zoom of [1, 1.2, 1.44, 0.833333, 0.5787037, 1, 2, 0.5, 1]) {
      const height = titleBarOverlayFor("fabplane-dark", zoom).height;
      expect(height).toBe(Math.floor(47 * zoom));
      expect(height).toBeLessThan(TITLE_BAR_HEIGHT * zoom);
      expect(Number.isInteger(height)).toBe(true);
    }
    expect(titleBarOverlayFor("fabplane-dark").height).toBe(47);
  });

  test("theme changes preserve zoomed geometry and update native colours", () => {
    const dark = titleBarOverlayFor("fabplane-dark", 0.5787037);
    const light = titleBarOverlayFor("fabplane-light", 0.5787037);
    expect(light.height).toBe(dark.height);
    expect(light.color).not.toBe(dark.color);
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
