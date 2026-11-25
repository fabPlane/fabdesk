import { describe, expect, test } from "bun:test";
import type { PrivacyStatus } from "@fabdesk/protocol";
import { needsPrivacyScreen, privacyScreenRequired } from "./privacy-gate";

const status = (firstInstallScreen: boolean): PrivacyStatus => ({
  mode: "auto",
  firstInstallScreen,
  region: { likelyInRegion: firstInstallScreen, signal: firstInstallScreen ? "time-zone" : null, country: null },
});

describe("privacy gate", () => {
  test("follows the core's decision", () => {
    expect(privacyScreenRequired({ data: status(true), isError: false })).toBe(true);
    expect(privacyScreenRequired({ data: status(false), isError: false })).toBe(false);
  });

  test("waits for the core, and asks when an older core has no answer", () => {
    expect(privacyScreenRequired({ isError: false })).toBeNull();
    expect(privacyScreenRequired({ isError: true })).toBe(true);
  });

  test("analytics asks in every region, including legacy installations", () => {
    expect(needsPrivacyScreen({ productAnalyticsChoiceComplete: false, usageArchiveChoiceComplete: true }, false)).toBe(true);
    expect(needsPrivacyScreen({ productAnalyticsChoiceComplete: true, usageArchiveChoiceComplete: true }, false)).toBe(false);
  });

  test("shows the screen only to undecided installations that need it", () => {
    expect(needsPrivacyScreen({ productAnalyticsChoiceComplete: true, usageArchiveChoiceComplete: false }, true)).toBe(true);
    expect(needsPrivacyScreen({ productAnalyticsChoiceComplete: true, usageArchiveChoiceComplete: true }, true)).toBe(false);
    expect(needsPrivacyScreen({ productAnalyticsChoiceComplete: true, usageArchiveChoiceComplete: false }, false)).toBe(false);
  });
});
