import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { themeBootInlineCss, themeBootInlineScript } from "./boot-inline";
import {
  THEME_BACKGROUNDS,
  THEME_IDS,
  UI_THEME_STORAGE_KEY,
  applyThemeIdTo,
  bootstrapTheme,
  isThemeId,
  parsePersistedThemeId,
  resolveThemeId,
  themeBackground,
  themeFromPreference,
} from "./resolve";

describe("resolveThemeId", () => {
  test("stored Appearance choice wins over core pref and OS", () => {
    expect(resolveThemeId("plain-light", "dark", true)).toBe("plain-light");
    expect(resolveThemeId("fabplane-dark", "light", false)).toBe("fabplane-dark");
  });

  test("falls back to core pref when nothing is stored", () => {
    expect(resolveThemeId(null, "dark", false)).toBe("fabplane-dark");
    expect(resolveThemeId(undefined, "light", true)).toBe("fabplane-light");
  });

  test("system / missing pref follows OS", () => {
    expect(resolveThemeId(null, "system", true)).toBe("fabplane-dark");
    expect(resolveThemeId(null, "system", false)).toBe("fabplane-light");
    expect(resolveThemeId(null, undefined, true)).toBe("fabplane-dark");
    expect(resolveThemeId(null, undefined, false)).toBe("fabplane-light");
  });

  test("rejects unknown stored values", () => {
    expect(resolveThemeId("dark" as never, "light", true)).toBe("fabplane-light");
  });
});

describe("themeFromPreference", () => {
  test("dark / light are explicit", () => {
    expect(themeFromPreference("dark", false)).toBe("fabplane-dark");
    expect(themeFromPreference("light", true)).toBe("fabplane-light");
  });
});

describe("parsePersistedThemeId", () => {
  test("reads zustand persist payload for fabdesk.ui", () => {
    expect(parsePersistedThemeId(JSON.stringify({ state: { themeId: "fabplane-dark" }, version: 3 }))).toBe(
      "fabplane-dark",
    );
    expect(parsePersistedThemeId(JSON.stringify({ state: { themeId: "plain-light" }, version: 3 }))).toBe("plain-light");
  });

  test("returns null for missing, invalid, or empty payloads", () => {
    expect(parsePersistedThemeId(null)).toBeNull();
    expect(parsePersistedThemeId(undefined)).toBeNull();
    expect(parsePersistedThemeId("")).toBeNull();
    expect(parsePersistedThemeId("not-json")).toBeNull();
    expect(parsePersistedThemeId(JSON.stringify({ state: { themeId: null }, version: 3 }))).toBeNull();
    expect(parsePersistedThemeId(JSON.stringify({ state: { themeId: "dark" }, version: 3 }))).toBeNull();
    expect(parsePersistedThemeId(JSON.stringify({ themeId: "fabplane-dark" }))).toBeNull();
  });
});

describe("applyThemeIdTo / bootstrapTheme", () => {
  function mockRoot() {
    const classes = new Set<string>();
    return {
      classes,
      root: {
        classList: {
          toggle: (token: string, force?: boolean) => {
            if (force) classes.add(token);
            else classes.delete(token);
          },
        },
        dataset: {} as { theme?: string; skin?: string },
        style: {} as { colorScheme?: string; backgroundColor?: string },
      },
    };
  }

  test("sets dark class, data attributes, color-scheme, and background", () => {
    const { classes, root } = mockRoot();
    expect(applyThemeIdTo("plain-dark", root)).toBe(true);
    expect(classes.has("dark")).toBe(true);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.skin).toBe("plain");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.backgroundColor).toBe(THEME_BACKGROUNDS["plain-dark"]);
  });

  test("clears dark class for a light theme", () => {
    const { classes, root } = mockRoot();
    applyThemeIdTo("fabplane-dark", root);
    applyThemeIdTo("fabplane-light", root);
    expect(classes.has("dark")).toBe(false);
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.skin).toBe("fabplane");
    expect(root.style.colorScheme).toBe("light");
    expect(root.style.backgroundColor).toBe(THEME_BACKGROUNDS["fabplane-light"]);
  });

  test("bootstrapTheme reads the persist key and follows OS when unset", () => {
    const { classes, root } = mockRoot();
    const id = bootstrapTheme(
      {
        getItem: (key) => {
          expect(key).toBe(UI_THEME_STORAGE_KEY);
          return JSON.stringify({ state: { themeId: "plain-light" }, version: 3 });
        },
        prefersDark: true,
      },
      root,
    );
    expect(id).toBe("plain-light");
    expect(classes.has("dark")).toBe(false);

    const os = mockRoot();
    expect(bootstrapTheme({ getItem: () => null, prefersDark: true }, os.root)).toBe("fabplane-dark");
    expect(os.classes.has("dark")).toBe(true);
  });
});

describe("theme boot inline script", () => {
  test("embeds the persist key, theme ids, and background tokens", () => {
    const src = themeBootInlineScript();
    expect(src).toContain(UI_THEME_STORAGE_KEY);
    for (const id of THEME_IDS) expect(src).toContain(id);
    for (const bg of Object.values(THEME_BACKGROUNDS)) expect(src).toContain(bg);
    expect(src.startsWith("(function(){")).toBe(true);
  });

  test("inline CSS covers html/body/#root for each skin", () => {
    const css = themeBootInlineCss();
    expect(css).toContain("html,body,#root");
    expect(css).toContain(THEME_BACKGROUNDS["fabplane-dark"]);
    expect(css).toContain(THEME_BACKGROUNDS["fabplane-light"]);
    expect(css).toContain(THEME_BACKGROUNDS["plain-dark"]);
    expect(css).toContain(THEME_BACKGROUNDS["plain-light"]);
    expect(css).toContain('html.dark[data-skin="plain"]');
  });

  test("IIFE applies the persisted dark theme on a mock document", () => {
    const attrs: Record<string, string> = {};
    const style: Record<string, string> = {};
    let darkOn = false;
    const document = {
      documentElement: {
        classList: {
          toggle: (_name: string, force?: boolean) => {
            darkOn = Boolean(force);
          },
        },
        setAttribute: (k: string, v: string) => {
          attrs[k] = v;
        },
        style,
      },
    };
    const payload = JSON.stringify({ state: { themeId: "fabplane-dark" }, version: 3 });
    const localStorage = { getItem: () => payload };
    const window = { matchMedia: () => ({ matches: false }) };
    runInNewContext(themeBootInlineScript(), { document, localStorage, window });
    expect(darkOn).toBe(true);
    expect(attrs["data-theme"]).toBe("dark");
    expect(attrs["data-skin"]).toBe("fabplane");
    expect(style.colorScheme).toBe("dark");
    expect(style.backgroundColor).toBe(themeBackground("fabplane-dark"));
  });

  test("IIFE follows prefers-color-scheme when nothing is stored", () => {
    const style: Record<string, string> = {};
    let darkOn = false;
    const document = {
      documentElement: {
        classList: {
          toggle: (_name: string, force?: boolean) => {
            darkOn = Boolean(force);
          },
        },
        setAttribute: () => {},
        style,
      },
    };
    const run = (matches: boolean) =>
      runInNewContext(themeBootInlineScript(), {
        document,
        localStorage: { getItem: () => null },
        window: { matchMedia: () => ({ matches }) },
      });
    run(true);
    expect(darkOn).toBe(true);
    expect(style.backgroundColor).toBe(themeBackground("fabplane-dark"));
    run(false);
    expect(darkOn).toBe(false);
    expect(style.backgroundColor).toBe(themeBackground("fabplane-light"));
  });
});

describe("isThemeId", () => {
  test("accepts the four Appearance ids only", () => {
    expect(THEME_IDS.every(isThemeId)).toBe(true);
    expect(isThemeId("system")).toBe(false);
    expect(isThemeId("dark")).toBe(false);
  });
});
