import { describe, expect, test } from "bun:test";
import { detectAppLocale } from "@fabdesk/protocol";
import { detectHostLocale, hostLocales } from "./I18nProvider";

describe("host locale persistence inputs", () => {
  test("hostLocales reads navigator when present", () => {
    const languages = hostLocales();
    expect(Array.isArray(languages)).toBe(true);
    const detected = detectHostLocale();
    expect(detectAppLocale({ languages: languages.length ? languages : ["en"] })).toBe(detected);
  });
});
