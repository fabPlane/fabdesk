import { describe, expect, test } from "bun:test";
import { mobileLocale, translate } from "./i18n";

describe("mobile locale helper", () => {
  test("follows the system languages until a locale is saved", () => {
    expect(mobileLocale("system", ["th-TH", "en"])).toBe("th");
    expect(mobileLocale("ja", ["th-TH"])).toBe("ja");
  });

  test("shared catalogs supply settings copy", async () => {
    const { preloadMobileCatalog } = await import("./i18n");
    await preloadMobileCatalog("de");
    expect(translate("de", "settings.language.ui")).toBe("App-Sprache");
    expect(translate("de", "settings.language.matchMessage")).toContain("Nachricht");
  });
});
