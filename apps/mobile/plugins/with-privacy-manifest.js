/**
 * App-level `ios/PrivacyInfo.xcprivacy` (App Store requirement since May 2024). The values are
 * merged into `ios.privacyManifests`, which prebuild turns into the file; a plugin only so the
 * declaration is one reviewable file with the reasons spelled out, instead of opaque codes in
 * `app.json`. Third-party SDKs (Sentry, Expo modules) ship their own manifests in their pods and
 * Xcode aggregates them; this covers what the app binary itself touches.
 *
 * Reason codes: https://developer.apple.com/documentation/bundleresources/privacy_manifest_files/describing_use_of_required_reason_api
 * Data types:   https://developer.apple.com/documentation/bundleresources/privacy_manifest_files/describing_data_use_in_privacy_manifests
 *
 * Plain JS on purpose: Expo `require`s local config plugins without a TypeScript transform.
 */
const { withDangerousMod } = require("expo/config-plugins");

/** The React Native / Expo baseline: what the framework itself calls, regardless of app code. */
const REQUIRED_REASON_APIS = [
  // NSUserDefaults: AsyncStorage, expo-secure-store's metadata, RN's own DevSettings.
  {
    NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
    NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
  },
  // stat()/mtime on files the app wrote: expo-file-system, expo-image's cache, Metro's asset store.
  {
    NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
    NSPrivacyAccessedAPITypeReasons: ["C617.1"],
  },
  // mach_absolute_time / boot time: React Native's timers and Reanimated's frame clock.
  {
    NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
    NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
  },
  // Free-space checks before writing caches (expo-file-system, expo-image).
  {
    NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
    NSPrivacyAccessedAPITypeReasons: ["E174.1"],
  },
];

/**
 * What leaves the phone and where. Crash reports go to Sentry (docs/mobile-release.md); nothing is
 * linked to an identity and nothing is used for tracking. Everything else the app sends goes to
 * the user's own computer over their own network.
 */
const COLLECTED_DATA = [
  {
    NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeCrashData",
    NSPrivacyCollectedDataTypeLinked: false,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  },
  {
    NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeOtherDiagnosticData",
    NSPrivacyCollectedDataTypeLinked: false,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  },
  {
    // Hold-to-talk: audio is transcribed (on this phone when possible, else on the paired
    // computer) and discarded. It is not stored and not used for tracking.
    NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeAudioData",
    NSPrivacyCollectedDataTypeLinked: false,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  },
];

/** @param {import("expo/config").ExpoConfig} config */
function withPrivacyManifest(config) {
  const ios = { ...(config.ios ?? {}) };
  const existing = ios.privacyManifests ?? {};
  ios.privacyManifests = {
    ...existing,
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: existing.NSPrivacyTrackingDomains ?? [],
    NSPrivacyAccessedAPITypes: [
      ...(existing.NSPrivacyAccessedAPITypes ?? []),
      ...REQUIRED_REASON_APIS,
    ],
    NSPrivacyCollectedDataTypes: [
      ...(existing.NSPrivacyCollectedDataTypes ?? []),
      ...COLLECTED_DATA,
    ],
  };
  // A no-op dangerous mod keeps this a real plugin in the mod chain (it shows up in
  // `expo config --type introspect`); prebuild's built-in PrivacyInfo mod does the actual write.
  return withDangerousMod({ ...config, ios }, ["ios", async (c) => c]);
}

module.exports = withPrivacyManifest;
module.exports.REQUIRED_REASON_APIS = REQUIRED_REASON_APIS;
module.exports.COLLECTED_DATA = COLLECTED_DATA;
