import { describe, expect, test } from "bun:test";
import {
  CONSENT_REGION_COUNTRIES,
  CONSENT_REGION_TIME_ZONES,
  detectConsentRegion,
  localeRegion,
} from "../src/index";

describe("localeRegion", () => {
  test.each([
    ["de-DE", "DE"],
    ["de_DE.UTF-8", "DE"],
    ["en_GB@euro", "GB"],
    ["fr-ch", "CH"],
    ["sr-Latn-RS", "RS"],
    ["es-419", null],
    ["en", null],
    ["C", null],
    ["POSIX", null],
    ["C.UTF-8", null],
    ["", null],
    ["  pt_PT  ", "PT"],
  ] as const)("%p → %p", (locale, region) => {
    expect(localeRegion(locale)).toBe(region);
  });
});

describe("detectConsentRegion", () => {
  test.each([
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Dublin",
    "Europe/London",
    "Europe/Zurich",
    "Europe/Oslo",
    "Atlantic/Reykjavik",
    "Europe/Vaduz",
    "Atlantic/Canary",
    "Atlantic/Azores",
    "Indian/Reunion",
    "Asia/Nicosia",
    "GB",
  ])("%p is in the region", (timeZone) => {
    expect(detectConsentRegion({ timeZone })).toMatchObject({ likelyInRegion: true, signal: "time-zone" });
  });

  test.each([
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "Australia/Sydney",
    "UTC",
    "Etc/UTC",
    "Europe/Moscow",
    "Europe/Istanbul",
    "Europe/Kyiv",
    "Europe/Belgrade",
    "Europe/Minsk",
    "Europe/Andorra",
    "Europe/Monaco",
  ])("%p is outside the region", (timeZone) => {
    expect(detectConsentRegion({ timeZone }).likelyInRegion).toBe(false);
  });

  test("reports the zone's country, or null for a generic zone", () => {
    expect(detectConsentRegion({ timeZone: "Europe/Madrid" }).country).toBe("ES");
    expect(detectConsentRegion({ timeZone: "CET" })).toEqual({ likelyInRegion: true, signal: "time-zone", country: null });
  });

  test("a locale region in scope counts even when the zone does not", () => {
    expect(detectConsentRegion({ timeZone: "America/New_York", locales: ["en-US", "de_AT.UTF-8"] })).toEqual({
      likelyInRegion: true,
      signal: "locale",
      country: "AT",
    });
    expect(detectConsentRegion({ timeZone: "UTC", locales: ["en-GB"] }).country).toBe("GB");
  });

  test("language-only and out-of-scope locales do not", () => {
    expect(
      detectConsentRegion({ timeZone: "Asia/Tokyo", locales: ["de", "fr", "en-US", "ja-JP", "tr-TR", null, ""] }),
    ).toEqual({ likelyInRegion: false, signal: null, country: null });
  });

  test("no signals means outside the region", () => {
    expect(detectConsentRegion({})).toEqual({ likelyInRegion: false, signal: null, country: null });
    expect(detectConsentRegion({ timeZone: "toString" }).likelyInRegion).toBe(false);
  });

  test("every mapped zone names a country in scope", () => {
    for (const [zone, country] of Object.entries(CONSENT_REGION_TIME_ZONES))
      if (country !== null) expect([zone, CONSENT_REGION_COUNTRIES.has(country)]).toEqual([zone, true]);
  });

  test("covers all EU, EEA, UK and Swiss country codes", () => {
    const eu = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" ");
    for (const c of [...eu, "IS", "LI", "NO", "GB", "CH"]) expect([c, CONSENT_REGION_COUNTRIES.has(c)]).toEqual([c, true]);
    expect(eu).toHaveLength(27);
  });

  test("every in-scope country has at least one zone", () => {
    const zoned = new Set(Object.values(CONSENT_REGION_TIME_ZONES));
    for (const c of CONSENT_REGION_COUNTRIES) expect([c, zoned.has(c)]).toEqual([c, true]);
  });
});
