# Mobile release

How `apps/mobile` is built, versioned, monitored and tested for release. What the app _is_ lives
in [mobile.md](mobile.md); this is the pipeline around it. Everything below runs from the repo
root unless it says `apps/mobile`.

```
 release.yml  version ─┬─ build (desktop × 4)  ─ release ─ website
                       └─ mobile: stamp app.json → typecheck/test → eas build --profile preview (EXPO_TOKEN)
 mobile.yml   verify (typecheck, test, expo export) ─┬─ eas-preview   main / dispatch, EXPO_TOKEN
                                                     └─ e2e-ios       vars.MOBILE_E2E == '1'
```

## One-time setup (a human, once)

None of this has been done from an agent session: it needs an Expo login, Apple and Google
credentials, and a Sentry project. In order:

1. **EAS project.** Signed in to Expo as the Voxly team (`npx eas-cli login`), run
   `cd apps/mobile && npx eas-cli init`. It writes `extra.eas.projectId` into `app.json`; commit
   that. `owner` in `app.json` is `voxly` — if the team's Expo slug differs, `eas init` will say
   so; change `owner` to match. Until the id is committed, CI can pass it as the `EAS_PROJECT_ID`
   repository variable (read by `app.config.ts`).
2. **`EXPO_TOKEN` secret.** An Expo access token for the team (expo.dev → Account settings →
   Access tokens) as a repository secret. Both workflows skip their EAS steps with a notice while
   it is absent, so adding it is what turns cloud builds on.
3. **Apple.** The first `eas build --platform ios --profile preview` run interactively on a
   workstation creates the distribution certificate and an ad-hoc provisioning profile under the
   team (`CMNZZ92926`) and stores them in EAS; after that `--non-interactive` works in CI. Store
   submission also needs an App Store Connect API key (`eas credentials`) — not needed for preview
   builds. The APNs key is **not** uploaded to EAS — fabplane.com talks to APNs directly (see
   the push section below); the profile only needs the Push Notifications capability.
4. **Google.** `eas build --platform android --profile preview` generates and stores an upload
   keystore on first run. For Play, a service-account JSON with release access goes into EAS
   (`eas credentials --platform android`) and `eas submit --profile production` uses the
   `internal` track (`eas.json`). FCM needs only the committed `google-services.json`; the
   service account lives on the API hosts.
5. **Sentry.** In org `tensorfleet-6g` (the desktop's org, [sentry.md](sentry.md)) create a React
   Native project `fabplane-mobile`. Then in EAS (expo.dev → project → Environment variables, or
   `eas env:create`) for the `preview` and `production` environments:
   - `SENTRY_DSN_MOBILE` — the project DSN (plain text; it is a public write-only key)
   - `SENTRY_ORG=tensorfleet-6g`, `SENTRY_PROJECT=fabplane-mobile`
   - `SENTRY_AUTH_TOKEN` — an org auth token with `project:releases` and `org:read`
     (**secret**), used only to upload source maps and dSYMs at build time
6. **Enable the simulator E2E** when someone wants it on every PR: repository variable
   `MOBILE_E2E=1`. It is ~20 minutes of macOS runner per run, which is why it is opt-in.

## Push credentials (direct APNs / FCM)

The phone registers the **native** device token (`getDevicePushTokenAsync()`: a 64-hex APNs
token on iOS, an FCM registration token on Android) with the daemon, and fabplane.com delivers
through APNs and FCM itself (`docs/mobile-notifications.md` §4.2). No Expo push service, no
`EXPO_ACCESS_TOKEN`, no EAS credential upload is involved in delivery. What the build and the
backend need:

1. **iOS** — the `aps-environment` entitlement (`expo-notifications` adds it via the config
   plugin) and a provisioning profile that includes Push Notifications for
   `com.fabplane.fabdesk`; the APNs auth key (`4D823P5T3R`, team `CMNZZ92926`) lives on the API
   hosts, not in EAS. A simulator never gets an APNs token — test on a device.
2. **Android** — `apps/mobile/google-services.json` (Firebase app `com.tensorfleet.fabdesk.mobile`;
   client config, committed) is referenced by `app.config.ts` and needs a native rebuild
   (`bunx expo prebuild --platform android --clean` or `expo run:android`) to take effect. The
   Firebase service-account JSON stays on the API hosts and must **not** be committed.
3. **Verify** — on the backend checkout `bun run push:selftest` should answer with a provider
   result (a dummy token is rejected as unregistered rather than `ProviderNotConfigured`). Then
   from this repo, log a daemon in against staging and finish a run — its log should show
   `push sent {count:1, ok:1}`:
   ```bash
   FABDESK_HOME=/tmp/fab-staging FABPLANE_API_ORIGIN=http://fabplane-staging.tail4f6a7.ts.net:4000 \
     bun run --cwd apps/core src/main.ts login --email maya --password fabplane-dev
   FABDESK_HOME=/tmp/fab-staging FABPLANE_API_ORIGIN=http://fabplane-staging.tail4f6a7.ts.net:4000 \
     FABDESK_TOKEN=dev-token-0123456789 bun run --cwd apps/core src/main.ts serve --port 47810
   ```
   Pair a phone, check Settings → Notifications shows a registered token (`GET /v1/devices/me`
   returns `push.tokenKind`), send a message, background the app for a minute, and the
   notification should arrive through APNs/FCM rather than locally.

## Versions and build numbers

`scripts/set-version.ts <version>` (run by `release.yml`) stamps `expo.version` in
`apps/mobile/app.json` and derives one integer for both stores — `0.3.512` → `300512`
(`major·10⁸ + minor·10⁵ + patch`) — written to `ios.buildNumber` and `android.versionCode`.
Derived rather than counted so it needs no state and is monotonic in the release order
(`0.<minor>.<run_number>`, [releases.md](releases.md)). `eas.json` has
`appVersionSource: "local"`, so EAS takes these numbers as-is and never auto-increments.

`runtimeVersion` is `{ policy: "appVersion" }` and `updates.enabled` is `false`: there are no OTA
updates, every change is a store build. If EAS Update is ever turned on, the policy already
scopes an update to the exact app version it was built from.

## Building

| Profile              | What                                                                 | Command                                                 |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `development`        | dev client for the iOS **simulator** and an Android APK; needs Metro | `eas build --profile development --platform ios`        |
| `development-device` | the same for a physical iPhone (ad-hoc, register the device first)   | `eas build --profile development-device --platform ios` |
| `preview`            | internal distribution, release configuration, bundle embedded        | `eas build --profile preview --platform all`            |
| `production`         | store build: `.ipa` for TestFlight/App Store, `.aab` for Play        | `eas build --profile production` then `eas submit`      |

All from `apps/mobile`. `eas build --local` works for the iOS profiles on a Mac with Xcode and is
what to reach for when a cloud build fails in a way the logs do not explain.

Without EAS, a Release simulator build is `bunx expo run:ios --configuration Release --device
<udid>`; `apps/mobile/e2e/run.sh --build` wraps that and CI's `e2e-ios` job uses it.

Device builds straight from this Mac, the way the 2026-09 test builds were made:

- **iOS** — `xcodebuild -workspace ios/fabPlane.xcworkspace -scheme fabPlane -configuration
Release -destination 'id=<device udid>' -derivedDataPath ios/build/device
-allowProvisioningUpdates DEVELOPMENT_TEAM=CMNZZ92926 build`, then `xcrun devicectl device
install app --device <udid> ios/build/device/Build/Products/Release-iphoneos/fabPlane.app`.
  The `.app` directory appears long before signing finishes — wait for `BUILD SUCCEEDED`, not
  for the path. `devicectl device process launch --payload-url 'fabdesk://pair?…'` opens a
  pairing link on the phone without touching it (the phone must be unlocked).
- **Android** — `bunx expo prebuild --platform android` (add `--clean` after changing
  `app.json`/plugins; it also deletes `android/local.properties`, so recreate it with
  `sdk.dir=$HOME/Library/Android/sdk`), then `cd android && JAVA_HOME="/Applications/Android
Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease` — the system Temurin 26 is
  too new for this Gradle — and `adb install -r app/build/outputs/apk/release/app-release.apk`.

## Error reporting

`src/observability.ts` initialises `@sentry/react-native` when `extra.sentryDsn` is present in
the app config, which `app.config.ts` sets from `SENTRY_DSN_MOBILE` at build time. No DSN, no
SDK init, no config plugin — a local or CI build has no Sentry native config at all. Errors only:
unhandled JS errors, native crashes, and three transport transitions (`lib/transport-failures`):
no saved address answered, the device token was rejected, an open event stream dropped while the
app was in the foreground. Tracing, sessions, screenshots, view hierarchies and failed-request
capture are off; `fetch`/`console` breadcrumbs are dropped so a pairing token or message text
cannot ride along. Tags: `platform`, `daemonVersion`, `coreId`.

Release naming is the SDK's default, `<bundle id>@<version>+<buildNumber>`, which is also what
`sentry-cli` names the uploaded symbols with, so nothing is configured on either side.

### Source maps

[AGENTS.md](../AGENTS.md) forbids shipping source maps, and none ship:

- **iOS.** The Sentry config plugin wraps the "Bundle React Native code and images" phase with
  `sentry-xcode.sh`, which sets `SOURCEMAP_FILE` to `$DERIVED_FILE_DIR/main.jsbundle.map` — inside
  Xcode's DerivedData, never inside the `.app` — uploads it, and leaves it there. The `.ipa`
  contains `main.jsbundle` only. Debug symbols (`dSYM`) are uploaded by a separate phase.
- **Android.** `sentry.gradle` hooks the bundle task, uploads the map, then runs a `Delete` task
  on it (and on `intermediates/assets/release/index.android.bundle.map`) before packaging.
- **CI bundle check.** `mobile.yml`'s `expo export` runs without `--source-maps`; the release
  workflow never calls `expo export` at all. The build phases above need `SENTRY_AUTH_TOKEN`; a
  DSN with no token fails the build with a message naming the variable, on purpose — a release
  without symbols is worse than a red build. `SENTRY_DISABLE_AUTO_UPLOAD=true` (set for the
  `development` profile) skips the upload and the map is still written only to DerivedData /
  deleted by gradle.

## Privacy manifest and data safety

`apps/mobile/plugins/with-privacy-manifest.js` writes `ios/PrivacyInfo.xcprivacy` at prebuild
via Expo's `ios.privacyManifests`. Declared: the React Native baseline of required-reason APIs
(`UserDefaults` CA92.1, `FileTimestamp` C617.1, `SystemBootTime` 35F9.1, `DiskSpace` E174.1) and
two collected data types, crash data and other diagnostic data, neither linked to identity nor
used for tracking; `NSPrivacyTracking` is false. SDKs with their own manifests (Sentry, the Expo
modules) are aggregated by Xcode.

The same answers for the **Play Console data-safety form**:

| Question                           | Answer                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the app collect or share data | Collects: **Crash logs** and **Diagnostics** (App performance) — optional, not shared, encrypted in transit, can be deleted by request (Sentry retention). Not used for tracking or ads. |
| Personal info, messages, photos    | Not collected. Chat text and attached photos go only to the user's own computer over their own network; nothing reaches Voxly or a third party.                                          |
| Device or other IDs                | Not collected. The push token is stored on the user's own daemon and used by fabplane.com only to address APNs/FCM.                                                                      |
| Location, contacts, financial      | Not collected. Camera is used for scanning the pairing QR code only; frames are not stored.                                                                                              |
| Security practices                 | Data encrypted in transit (Sentry: HTTPS; daemon traffic: the user's tailnet). Users can request deletion.                                                                               |

**App Store privacy nutrition label:** Diagnostics → Crash Data and Other Diagnostic Data, "Not
linked to you", "Not used to track you". Everything else: Data Not Collected.

## Screenshots

`scripts/mobile-screenshots.sh` captures the six main screens from a booted iOS simulator into
`docs/screenshots/mobile/` (`--out` to change): Chats, a chat with one exchange, Projects, a
project, Settings, Connections. It starts the same fake-agent daemon the E2E flow uses, pairs the
simulator over the deep link, seeds one thread through the API, and reaches every screen by its
expo-router deep link before `xcrun simctl io screenshot`. The app must already be installed —
`apps/mobile/e2e/run.sh --build` makes a Release one; for a dev client pass `--dev-client` with
Metro running. Store listings need the 6.7" (1290×2796) and 6.5" sizes: run once on an iPhone 16
Pro Max simulator and once on an 11 Pro Max, `--udid` each.

## End-to-end test

`apps/mobile/e2e/pair-and-chat.yaml` is a Maestro flow: pair via `fabdesk://pair?…` → Chats
shows the daemon's project → new chat in it → send → the reply streams in. `e2e/run.sh` starts
`e2e/daemon.ts` (a real `fabdesk-core` with mock services, a fake `claude` adapter that answers
every message with a fixed line, one project, remote listener on `127.0.0.1:<port>`), mints the
pairing URL, and runs `maestro test` with it. Locally:

```bash
curl -Ls https://get.maestro.mobile.dev | bash          # once; lands in ~/.maestro/bin
apps/mobile/e2e/run.sh --build                          # Release simulator build, then the flow
apps/mobile/e2e/run.sh --dev-client                     # against an installed dev client + Metro
apps/mobile/e2e/run.sh --port 47821 --app-id com.x.y    # when 47820 is taken / another build
```

The flow uses only accessibility labels and visible text the screens already have (`New chat in
<project>`, the `Message claude` placeholder, `Send`); no test ids were added. CI's `e2e-ios` job
runs it on a macOS runner behind `vars.MOBILE_E2E == '1'` and uploads `~/.maestro/tests` on
failure.

A dev client on the simulator that predates a native module the branch now uses (say
`expo-notifications` or Sentry) crashes at the Chats tab with `Cannot find native module …`;
that is the build, not the flow — rebuild the client (`bunx expo run:ios`) or use `--build`.
