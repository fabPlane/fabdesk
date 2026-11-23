import { describe, expect, test } from "bun:test";
import { Settings } from "./api";
import { APP_LOCALES, detectAppLocale, matchAppLocale } from "./locales";

describe("Settings locale fields", () => {
  test("default to system UI and match-message agent replies", () => {
    expect(Settings.parse({}).uiLocale).toBe("system");
    expect(Settings.parse({}).agentReplyLanguage).toBe("match");
    expect(Settings.parse({ uiLocale: "th", agentReplyLanguage: "ja" })).toMatchObject({
      uiLocale: "th",
      agentReplyLanguage: "ja",
    });
    expect(Settings.safeParse({ uiLocale: "xx" }).success).toBe(false);
    expect(Settings.safeParse({ agentReplyLanguage: "always-elvish" }).success).toBe(false);
  });

  test("every first-version locale is a valid stored choice", () => {
    for (const locale of APP_LOCALES) {
      expect(Settings.parse({ uiLocale: locale }).uiLocale).toBe(locale);
      expect(Settings.parse({ agentReplyLanguage: locale }).agentReplyLanguage).toBe(locale);
    }
  });
});

describe("detectAppLocale", () => {
  test("first matching navigator language wins", () => {
    expect(detectAppLocale({ languages: ["sv-SE", "th-TH", "en"] })).toBe("th");
    expect(matchAppLocale("zh-Hant-TW")).toBe("zh-Hant");
  });
});
