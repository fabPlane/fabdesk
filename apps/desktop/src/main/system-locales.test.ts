import { describe, expect, test } from "bun:test";
import { systemLocaleEnv } from "./system-locales";

describe("systemLocaleEnv", () => {
  test("joins the system locale and preferred languages, deduplicated", () => {
    expect(
      systemLocaleEnv({ getSystemLocale: () => "en-DE", getPreferredSystemLanguages: () => ["en-DE", "de-DE"] }),
    ).toEqual({ FABDESK_SYSTEM_LOCALES: "en-DE,de-DE" });
  });

  test("skips blanks and survives a throwing source", () => {
    expect(
      systemLocaleEnv({
        getSystemLocale: () => {
          throw new Error("not ready");
        },
        getPreferredSystemLanguages: () => ["", "fr-FR"],
      }),
    ).toEqual({ FABDESK_SYSTEM_LOCALES: "fr-FR" });
    expect(systemLocaleEnv({ getSystemLocale: () => "", getPreferredSystemLanguages: () => [] })).toEqual({});
  });
});
