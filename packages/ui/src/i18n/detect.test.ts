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

  test("hostLocales falls back to process env when navigator is absent", () => {
    const original = globalThis.navigator;
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const previous = env?.LANG;
    try {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
      if (env) env.LANG = "ja_JP.UTF-8";
      expect(hostLocales()).toContain("ja_JP.UTF-8");
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: original });
      if (env) {
        if (previous === undefined) delete env.LANG;
        else env.LANG = previous;
      }
    }
  });
});
