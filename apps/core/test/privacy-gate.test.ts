import { describe, expect, test } from "bun:test";
import { usageArchiveAllowed, usageArchiveChoice } from "@fabdesk/protocol";
import { Store } from "../src/db";
import { CONSENT_REGION_REMEMBERED_KEY, resolvePrivacyStatus, systemLocales } from "../src/privacy-gate";

const US = { timeZone: "America/Chicago", locales: ["en-US"] };
const DE = { timeZone: "Europe/Berlin", locales: ["de-DE"] };

function withStore(fn: (store: Store) => void) {
  const store = Store.open(":memory:");
  try {
    fn(store);
  } finally {
    store.close();
  }
}

describe("privacy gate", () => {
  test("compiled always shows the notice, so undecided installations wait", () => {
    withStore((store) => {
      const privacy = resolvePrivacyStatus({ settings: store.settings, env: {}, ...US });
      expect(privacy).toMatchObject({
        mode: "always",
        firstInstallScreen: true,
        region: { likelyInRegion: false },
      });
      expect(usageArchiveAllowed(store.settings.get(), privacy.firstInstallScreen)).toBe(false);
      store.settings.patch(usageArchiveChoice(true));
      expect(usageArchiveAllowed(store.settings.get(), privacy.firstInstallScreen)).toBe(true);
      store.settings.patch(usageArchiveChoice(false));
      expect(usageArchiveAllowed(store.settings.get(), privacy.firstInstallScreen)).toBe(false);
    });
  });

  test("inside the consent region, the default waits for an explicit choice", () => {
    withStore((store) => {
      const privacy = resolvePrivacyStatus({ settings: store.settings, env: {}, ...DE });
      expect(privacy).toMatchObject({
        mode: "always",
        firstInstallScreen: true,
        region: { likelyInRegion: true },
      });
      expect(usageArchiveAllowed(store.settings.get(), privacy.firstInstallScreen)).toBe(false);
      store.settings.patch(usageArchiveChoice(true));
      expect(usageArchiveAllowed(store.settings.get(), privacy.firstInstallScreen)).toBe(true);
    });
  });

  test("auto shows the screen only in the consent region", () => {
    withStore((store) => {
      expect(resolvePrivacyStatus({ settings: store.settings, env: {}, mode: "auto", ...US })).toEqual({
        mode: "auto",
        firstInstallScreen: false,
        region: { likelyInRegion: false, signal: null, country: null },
      });
    });
    withStore((store) => {
      expect(resolvePrivacyStatus({ settings: store.settings, env: {}, mode: "auto", ...DE })).toEqual({
        mode: "auto",
        firstInstallScreen: true,
        region: { likelyInRegion: true, signal: "time-zone", country: "DE" },
      });
    });
  });

  test("a locale passed by the desktop app is enough", () => {
    withStore((store) => {
      const status = resolvePrivacyStatus({
        settings: store.settings,
        env: { FABDESK_SYSTEM_LOCALES: "en-US,fr-FR" },
        timeZone: "UTC",
        mode: "auto",
      });
      expect(status.firstInstallScreen).toBe(true);
      expect(status.region).toMatchObject({ signal: "locale", country: "FR" });
    });
  });

  test("once detected in the region, leaving it keeps the screen", () => {
    withStore((store) => {
      expect(resolvePrivacyStatus({ settings: store.settings, env: {}, mode: "auto", ...DE }).firstInstallScreen).toBe(true);
      expect(store.settings.readRaw(CONSENT_REGION_REMEMBERED_KEY)).toBe(true);
      expect(resolvePrivacyStatus({ settings: store.settings, env: {}, mode: "auto", ...US })).toMatchObject({
        firstInstallScreen: true,
        region: { likelyInRegion: true, signal: "remembered" },
      });
    });
  });

  test("FABDESK_PRIVACY_SCREEN forces the screen on or off", () => {
    withStore((store) => {
      const always = resolvePrivacyStatus({ settings: store.settings, env: { FABDESK_PRIVACY_SCREEN: "always" }, ...US });
      expect(always).toMatchObject({ mode: "always", firstInstallScreen: true });
      const never = resolvePrivacyStatus({ settings: store.settings, env: { FABDESK_PRIVACY_SCREEN: "never" }, ...DE });
      expect(never).toMatchObject({ mode: "never", firstInstallScreen: false });
      // An unknown value falls back to the compiled mode.
      expect(resolvePrivacyStatus({ settings: store.settings, env: { FABDESK_PRIVACY_SCREEN: "yes" }, ...US }).mode).toBe("always");
    });
  });

  test("the compiled mode applies without an override", () => {
    withStore((store) => {
      expect(resolvePrivacyStatus({ settings: store.settings, env: {}, mode: "always", ...US }).firstInstallScreen).toBe(true);
      expect(resolvePrivacyStatus({ settings: store.settings, env: {}, mode: "never", ...DE }).firstInstallScreen).toBe(false);
    });
  });

  test("systemLocales reads the desktop list, POSIX variables and the runtime locale", () => {
    expect(
      systemLocales(
        { FABDESK_SYSTEM_LOCALES: "en-GB, de-DE", LC_ALL: "", LANG: "nl_NL.UTF-8", LANGUAGE: "fr_FR:en" },
        "en-US",
      ),
    ).toEqual(["en-GB", "de-DE", "nl_NL.UTF-8", "fr_FR", "en", "en-US"]);
    expect(systemLocales({}, "en-US")).toEqual(["en-US"]);
  });
});
