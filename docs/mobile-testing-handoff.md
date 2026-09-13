# Handoff: testing `apps/mobile` on real devices

For whoever picks this up with a real device or an Expo build service. The app was written and
statically verified in a Linux container with no device runtime; it has since had one pass on the
**iOS Simulator and the Android emulator** on a Mac (2026-09-12, see "Simulator pass" below), which
found and fixed seven runtime bugs. What is left unknown is what only a physical phone can answer:
the camera, the OS keystore on real hardware, iOS Local Network permission, backgrounding, and
network hand-offs.

Read [`docs/mobile.md`](mobile.md) first for what the app is and how pairing works. This document is
only about what to test and what is likely to break.

- **Branch:** `claude/experimental-ios-android-client-l1c8h7`
- **Commits:** `6e99f45` (extract `@fabdesk/client-core`, daemon remote access) → `904b6d3`
  (desktop Remote access + QR pairing) → `2d2914e` (the Expo app)
- **Stack:** Expo SDK 54, React Native 0.81.4, React 19.1, expo-router 6, New Architecture on

## What is actually verified

| Check                                                                 | How                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Root `bun install && bun run typecheck && bun run test` green         | run; 45 new tests                                                                         |
| No `react-native`/`expo` in the root install                          | `ls node_modules` after a clean `--frozen-lockfile` install                               |
| `apps/mobile` typechecks under the repo's strict settings             | `bun run mobile:typecheck`                                                                |
| Pure logic unit tests (25)                                            | `bun run mobile:test`                                                                     |
| **Metro resolves the aliased workspace packages and the app bundles** | `bunx expo export --platform android` → 1639 modules, 4.83 MB                             |
| Daemon remote listener, pairing, device-token issue/revoke            | `apps/core/test/remote.test.ts`, `devices.test.ts` — over real HTTP against a real daemon |

That last row matters: **the server half of this feature is tested end to end.** A phone is not
required to exercise pairing — `curl` against a daemon works, see "Testing without a phone" below.

## Simulator pass (2026-09-12)

Run on a Mac against a daemon started with the "Testing without a phone" recipe below, remote
listener bound to `127.0.0.1:47820` (the iOS Simulator shares the host's loopback; the Android
emulator reaches it at `10.0.2.2`). Driven through the simulator's accessibility tree
first, then with real touch input once the native simulator panel attached.

| Now verified at runtime                                                                                                               | Where                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Every screen mounts and renders under the New Architecture, on both platforms                                                         | all of `app/`                                          |
| Android cleartext HTTP to a bare IP (`10.0.2.2`) on API 34                                                                            | `usesCleartextTraffic` in `app.json`                   |
| Sending from the phone: composer → `POST /threads/:id/messages` → streamed reply, both platforms                                      | `app/thread/[id].tsx`                                  |
| The composer stays above the software keyboard on both platforms                                                                      | `app/thread/[id].tsx`                                  |
| Pinch-to-zoom in the board viewer (real two-finger gesture on iOS)                                                                    | `app/board/[id].tsx`                                   |
| Pairing via the `fabdesk://pair` link, sequential address fallback (unreachable LAN address first, then loopback)                     | `app/pair.tsx`, `claimFirstReachable`                  |
| `expo-secure-store` round-trips token + connection metadata across a cold start                                                       | `src/transport/connections.ts`                         |
| WebSocket connects, streams a live run (deltas, tool groups, Stop→Send), reconnects after a daemon restart and refetches (pid change) | `packages/client-core/src/ws.ts`, `CoreConnection.tsx` |
| `react-native-markdown-display` under React 19: bullets, inline code, paragraphs                                                      | `src/components/MessageParts.tsx`                      |
| `expo-image` sends the `Authorization` header — board renders load                                                                    | `src/components/ProjectImage.tsx`                      |
| Reanimated 4 + worklets + gesture-handler load; the board modal opens, pans and closes                                                | `app/board/[id].tsx`                                   |
| `/doctor` agents list, `/health` version/uptime in Settings                                                                           | `app/(tabs)/settings.tsx`                              |

### Bugs found and fixed in that pass

1. **Remote `/ws` rejected every phone.** React Native's WebSocket sends `Origin: http://<host>:<port>`
   for the URL it dials; the remote listener admitted only sockets with _no_ Origin, so every
   connection got `403 forbidden origin` and the app sat on "Reconnecting…" forever while REST
   worked. `originAllowedRemote` in `apps/core/src/serve.ts` now also accepts the listener's own
   host (nothing on that listener serves a page, so no browser can present it). Regression test in
   `apps/core/test/remote.test.ts`.
2. **The stream re-dialled on every render.** `CoreConnectionProvider` passed `subscribe` as an
   inline arrow; `useCoreEvents` lists it as an effect dependency, and `canResume` calls `setHealth`
   on each successful open — so each open re-rendered the provider, which closed the socket and
   opened another. Status never reached `open`. `subscribe` is now `useCallback`-ed on the transport.
3. **Cold start with a saved connection crashed** (`useCore must be used inside <CoreProvider>`).
   Between SecureStore hydration and the effect that starts locating, `phase` is still `"idle"` and
   `ConnectionGate` rendered the tabs with no provider underneath. The gate now renders children
   only from `"connecting"` on. Pairing in-session never hit this, which is why it survived.
4. **`fabdesk://pair?…` had no route.** The scheme was registered but opening the link landed on
   expo-router's "Unmatched Route". `app/pair.tsx` claims and redirects; the param→URL rebuild is
   `src/lib/pair-link.ts` (tested).
5. **Board modal had no way out** — `fullScreenModal` cannot be swiped away. It has a Close button
   now. Same commit: back buttons were titled `(tabs)` after the route group; the Stack uses
   `headerBackButtonDisplayMode: "minimal"`.
6. **Android keyboard covered the composer.** Expo SDK 54 makes Android edge-to-edge, and under
   edge-to-edge `windowSoftInputMode=adjustResize` no longer shrinks the window for the IME — so
   `KeyboardAvoidingView` with `behavior={undefined}` on Android left the text field and Send
   button behind the keyboard. It is `padding` on both platforms now, with the header height as
   the offset (`app/thread/[id].tsx`). Typed and sent from the emulator afterwards; the reply
   streamed back.
7. **Stranded pull-to-refresh spinner.** `RefreshControl` was bound to react-query's `isRefetching`;
   a background invalidation (reconnect, event) flips that true→false without a gesture and iOS
   leaves the spinner on screen. `usePullRefresh` (`src/components/pull-refresh.tsx`) tracks the
   pull instead.

Smaller things seen and left alone:

- A thread created on the desktop does not appear on the phone until something invalidates
  `["threads"]` — `POST /threads` emits no event. The first `agent.started` on it does, so in
  practice it shows up when the desktop sends the first message. Pull to refresh otherwise.
- Opening a thread mid-run briefly shows only the assistant message: the event reducer seeds the
  message cache before `GET /threads/:id/messages` resolves, and the fetch then overwrites it.
  Self-heals within a second.
- `pod install` from `apps/mobile/ios` fails under Ruby 4 + CocoaPods 1.17 with a
  `Unicode Normalization not appropriate for ASCII-8BIT` error unless `LANG=en_US.UTF-8` is set
  (`expo run:ios` runs it for you; set the variable first).
- The pairing URL lists tailnet/LAN addresses from the interfaces, regardless of what host the
  remote listener is actually bound to. Harmless in real use (it binds `0.0.0.0`), confusing when
  testing on loopback.

## Real devices (2026-09-12, later the same day)

Release builds went onto two physical devices from this Mac:

- **iPhone 17 Pro Max, iOS 26.6** — `xcodebuild -allowProvisioningUpdates` against the Personal
  Team (`ios.appleTeamId` in `app.json`), installed with `devicectl`. `expo run:ios --device` cannot
  do this on its own: it never passes `-allowProvisioningUpdates`, so a bundle ID Xcode has not seen
  fails with "No profiles for … were found". A Personal Team profile expires after 7 days; the
  Voxly LLC team in Xcode would give a year. The phone has to trust the profile once (Settings ›
  General › VPN & Device Management). Not yet paired with a real desktop — that test is still open.
- **AYN Thor, Android 13** — a landscape handheld with a 538×420 dp window. `orientation` was
  `portrait`, which rendered the whole app sideways; it is `default` now. Content is capped at
  760 dp (`readable` in `src/components/ui.tsx`) so prose does not run 120 characters wide. Every
  `TextInput` sets `disableFullscreenUI`, and the flag is verified in the field's `EditorInfo`
  (`imeOptions` carries `IME_FLAG_NO_FULLSCREEN`) — but this device's Gboard 18.1 goes fullscreen in
  landscape anyway. Text entry still works: type, DONE, then Send. Paired over USB with
  `adb reverse tcp:47820 tcp:47820` and a hand-built link with `h=127.0.0.1`.

The icon is the desktop tile cropped to its opaque centre (`assets/icon.png`, full-bleed, no alpha —
the tile's transparent rounded corners came out as a white frame on iOS) and, for Android's
adaptive mask, the same image padded to the centre 66% (`assets/adaptive-icon.png`).

## First pairing with a real desktop (2026-09-12, evening)

The iPhone scanned the QR from the desktop dev app (`bun run dev`, `fabPlane Dev` profile) and
failed on both addresses with `Network request failed`: the phone was not on the tailnet. The raw
message did not say that, so pairing failures now go through `describePairingFailure`
(`src/lib/pairing-failure.ts`, tested): an unreachable computer says to check Tailscale / Wi-Fi
and show a fresh code, a refused code says it is stale or used. Why the LAN address also failed
while the phone was on the same Wi-Fi is still open — most likely the iOS Local Network permission
prompt interrupting the first request; check Settings › Privacy & Security › Local Network.

Once paired, the Chats tab showed only project headers: the dev profile has its own database with
no threads, and the phone had no way to start one. There is now a `+` on each project header, a
**New chat** picker (`app/new-chat.tsx`) from the empty state, and a **New chat in this project**
button on the project screen; the agent is the daemon's `defaultAgent`. Verified against the real
desktop daemon from the simulator: create → send → run → streamed reply.

Seen, not fixed: the daemon titles a thread from its first message without emitting
`thread.updated`, so the header keeps saying "New chat" until the thread query refetches.

## Phases 1 and 2 (2026-09-13)

Six agents built the roadmap's Wave 1 and Wave 2 packages in parallel on `mobile/*` branches, all
merged onto the feature branch. Verified on the iPhone 16 Pro simulator, the AYN Thor (release
APK) and by inspection on the daemon:

| Package                                                           | Verified how                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 reconnect on foreground / network change, jitter, `staleSince` | unit tests; cold start reconnects; **not yet** a real background/foreground cycle on a phone                                                                                                                                                                                                    |
| T2 `thread.created/updated/deleted` events                        | created + auto-titled a thread server-side: it appeared, retitled and sorted on the phone with no interaction                                                                                                                                                                                   |
| T3 `/health` pre-flight before claim, iOS Local Network warm-up   | pairing via the daemon's own `…&k=loopback` URL on both platforms                                                                                                                                                                                                                               |
| D1 endpoint kinds, preferred endpoint, loopback warning           | `GET /v1/remote` returns kinds + `default`; desktop UI not exercised (dev app was closed)                                                                                                                                                                                                       |
| C1 thread actions + Archived                                      | `…` sheet on iOS; Pin reflected on the daemon                                                                                                                                                                                                                                                   |
| C2 agent + model picker                                           | pill shows `claude · haiku`; sheet lists the four installed agents, then models                                                                                                                                                                                                                 |
| C3 attachments                                                    | Thor: library picker → upload to `sketches/` → strip → sent as `parts: [text, image]`; the run started and Stop aborted it                                                                                                                                                                      |
| C4 list sort / fold / unread / running-first                      | live dots and ordering on both platforms                                                                                                                                                                                                                                                        |
| S1 settings                                                       | dark mode switches everywhere instantly; default-agent control; keyboard hint shows (native module loaded)                                                                                                                                                                                      |
| L1 wide layout + shortcuts                                        | iPad Pro 11" simulator shows the sidebar list beside the detail pane with the ⌘N / ⌘K hint; native key-command module compiles on both platforms (one Swift fix: `UIKeyCommand` needs the long initializer to set `propertyList`); opening a chat into the detail pane not tapped through       |
| B1 renders gallery                                                | screen opens from the project card; **before/after not yet exercised**                                                                                                                                                                                                                          |
| B2 SVG viewer                                                     | schematic renders on both; fix: tscircuit-era SVGs have no `viewBox`, so `ensureViewBox` adds one or the drawing is clipped                                                                                                                                                                     |
| B3 3D viewer                                                      | `render_glb` from the phone, then `<model-viewer>` in the WebView loaded the GLB on iOS and on the Thor via the same-origin path                                                                                                                                                                |
| B4 DRC/ERC                                                        | 6 ERC errors listed with badges; render on top                                                                                                                                                                                                                                                  |
| B5 files                                                          | tree with folder counts; `circuit.tsx` with TSX highlighting and line numbers                                                                                                                                                                                                                   |
| B6 Route Cinema on Skia                                           | **renders on the Thor** (a finished run copied from `~/fabdesk/blinky`: 50 frames, play/scrub/layers); blank only on the iOS **simulator** — the painter runs (49 shapes reported) but the Skia canvas presents nothing there, not even a debug `<Rect>`; a simulator quirk, not a bug to chase |
| B7 jobs                                                           | `render_glb` listed as done; cancel not exercised                                                                                                                                                                                                                                               |
| B8 projects create/remix/delete, folder grouping                  | not exercised beyond typecheck/tests                                                                                                                                                                                                                                                            |

Fixes made while integrating: full-bleed viewers (board, SVG, 3D, cinema controls) pad by the
bottom safe-area inset — under Android edge-to-edge their captions sat beneath the system nav
bar; the project's board preview is capped to 45% of the window height so a landscape handheld
does not get a screen-filling picture; `useUploadSketch` / `useRouteRunFrames` lost their
closing braces in two merge resolutions (caught by typecheck).

Native modules added by the lanes, all compiled into the current builds: `expo-network`,
`expo-image-picker`, `@react-native-async-storage/async-storage`, `expo-haptics`,
`expo-keep-awake`, `expo-file-system`, `react-native-svg`, `react-native-webview`,
`@shopify/react-native-skia`, and the local `modules/fabdesk-key-commands`.

## Phase 3 (2026-09-13, overnight)

Four lanes, merged: supervised runtime mode (daemon + adapters + desktop card), daemon push
registration and the Notifier, local + push notifications on the phone, and the chat features
(approval/question cards, runtime-mode switch, queue-while-running, slash commands, work log).
Verified against the merged daemon with the real Claude Code 2.1.252:

- A supervised thread asked to `touch` a file paused with `agent.approval_requested`;
  `GET /threads/:id.pending` listed it; approving with a **device token over the remote
  listener** resumed the run, the file appeared, the part shows `decision: approve, by: device`.
- The Notifier posted "Needs you · Supervised test" (`kind: run.needs_input`) and then "Done"
  (`kind: run.done`) to a stub fabplane.com, in the exact `docs/mobile-notifications.md` §4.2 shape.
- **Against real staging** (`fabplane-staging.tail4f6a7.ts.net:4000`, logged in as `maya`): the
  route the backend team shipped answers `200 { tickets: [{ status: "error", message: "expo push
is not configured", details: { error: "ProviderNotConfigured" } }] }` — the contract matches
  end to end. The daemon logs `push sent {count:1, ok:0}` plus the ticket error. **Later the
  same day** push moved to native device tokens: the phone now registers the raw APNs/FCM token
  (`tokenKind: "apns" | "fcm"` on the registration and on each `PushMessage`), fabplane.com
  delivers directly, and Expo's push service is out of the picture — no `EXPO_ACCESS_TOKEN`, no
  EAS project needed for delivery. Rebuild both apps (Android picks up `google-services.json`)
  before expecting a native token.
- **Staging routes native tokens** (checked 2026-09-13 with the daemon's `maya` session): a
  64-hex probe token with `platform: "ios"` answers `200 { tickets: [{ status: "error",
message: "BadDeviceToken", details: { error: "DeviceNotRegistered" } }] }` and an FCM-shaped
  probe answers `NotRegistered` / `DeviceNotRegistered` — both providers reached with our
  credentials. Their `push:selftest` inside the `staging-api-1` container says the same. One
  wrinkle, since fixed: the **first** APNs request after the container had been idle ~10 h came
  back `502 { error: "upstream" }` (a stale HTTP/2 session); fabplane.com `53c5ef9` retries
  once before response headers. That release also went to **production**, which already had
  the APNs (production origin) and FCM credentials — both provider self-tests pass there.
- **FCM end to end on the AYN Thor** (2026-09-13, release APK rebuilt with
  `google-services.json`): Settings → Notifications on → Android permission prompt → the daemon
  logged `device push registered` with `tokenKind: fcm`. With the app process killed
  (`adb shell am kill`, not `force-stop` — a force-stopped app is in Android's stopped state and
  gets no FCM at all) a finished run produced `push sent {count:1, ok:1}` on the daemon and
  "Done · Say hi in three words. / Claude finished in blinky on Mac" in the shade within a second.
  While the app is merely backgrounded its socket stays open, so the daemon counts it online
  and the phone shows the local notification instead — by design. Two fixes fell out: FCM
  hands `data` over as strings (`v: "1"`), which the tap handler rejected, so the tap opened
  Chats rather than the thread; and Android drew a solid disc for the small icon until
  `assets/notification-icon.png` (white glyph on transparent) was added. A third: a cold-start tap
  pushed `/thread/:id` before the daemon was located and `ThreadScreen` threw
  `useCore must be used inside <CoreProvider>` — thread, project and jobs now sit behind
  `ConnectionGate`. With all three in the APK the tap lands on the chat (verified).
- **APNs on the iPhone — verified** (2026-09-13, `com.fabplane.fabdesk` signed with
  `aps-environment: development` against staging's sandbox gateway): paired with the scratch
  daemon by opening the pairing link with `devicectl … --payload-url`, Notifications on →
  `tokenKind: apns` registered, app swiped away → `push sent {count:1, ok:1}` → the
  notification arrived on the phone. The first attempt with the app "closed" produced **no**
  push: iOS had suspended the app rather than closing the socket, and the remote listener's
  255 s idle timeout kept the phone on the live list, so the daemon neither pushed nor could
  the app notify locally. Fixed at both ends (`ceac97e`): the phone closes its event stream
  20 s into the background (`src/lib/dormancy.ts`) and reopens on return; the remote
  listener's WebSocket idle timeout is 40 s.

Adapter reality (from the supervised lane's live check): Claude Code's `--permission-prompt-tool`
works with `--print` and our `permission_prompt` MCP tool; Claude still auto-allows commands it
judges read-only (`ls`, `echo`) without asking. Codex `exec` has no approval hook — supervising it
needs an app-server JSON-RPC client; it reports `supportsSupervised: false`.

Not exercised on a phone yet: the approval card UI itself, the local notification while
backgrounded, and the Notifications settings card (need a device build with
`expo-notifications`; the next Release build includes it).

## Phases 4 and 5 (2026-09-13, overnight)

Four lanes, merged and wired:

- **Tailscale endpoint provider + CLI** — the daemon reads `tailscale status --json` (verified
  read-only against the real CLI here: `matthews-macbook-pro.tail4f6a7.ts.net`, HTTPS feature on),
  advertises the MagicDNS name and, once `tailscale serve` fronts the listener, an
  `https://<name>` endpoint that the pairing URL lists first (`s=` parallel to `k=`); phones try
  https candidates first. `fabdesk-core serve --remote`, `pair` (terminal QR), `devices
list/revoke` for headless machines. `tailscale serve` itself was **not** run against the user's
  config — "Set up" on the desktop's Tailscale HTTPS row is the first live test.
- **Relay** — `apps/relay` is a reference relay (Bun, ~zero deps); the daemon dials it out
  (`RelayLink`, on when `remote.relayUrl` is set and signed in), the phone gets a `ProxyTransport`
  when only the relay answers, and the QR carries the relay as endpoint kind `relay`. Proven by an
  in-process end-to-end test (daemon → relay → device-token client, HTTP + events); no relay is
  deployed anywhere yet — fabplane.com's team can port `apps/relay/src/server.ts`.
- **Multiple computers + hosted web pairing** — status dots per saved computer, a switcher in
  the Chats header, `queryClient.clear()` on switch; the browser client (`BrowserApp`) boots
  without the Electron bridge, `/pair?host=…#token=…` claims and saves a host in localStorage,
  and the remote listener now allows `https://fabplane.com` origins. The site route itself is the
  fabplane.com repo's.
- **Release** — `eas.json` profiles, `app.config.ts` layered over `app.json`, Sentry (errors only,
  no source maps in the bundle — verified), a Maestro flow that **ran green on the iPhone 16 Pro
  simulator** (pair → new chat → send → reply), `PrivacyInfo.xcprivacy` via a config plugin,
  screenshot script, `set-version.ts` stamping the app, a `mobile` job in `release.yml`. What a
  human must do once is listed in `mobile-release.md` (EAS init under the Voxly team, APNs key,
  FCM, Sentry project, the `EXPO_TOKEN` secret).

The iOS bundle id is now `com.fabplane.fabdesk` (paid team `CMNZZ92926`), so the next device
build is a separate app from the earlier `com.tensorfleet.fabdesk.mobile` installs. The Android
package followed on 2026-09-13 (`com.fabplane.fabdesk`, its own Firebase Android app; the
committed `google-services.json` carries both clients so an old-id build still compiles).

## Morning-after state (2026-09-13)

All five roadmap phases are merged on `claude/experimental-ios-android-client-l1c8h7` and pushed.
Verified on the iPhone 16 Pro simulator after the final native rebuild: pairing with the
environment pill, the Notifications card (permission prompt → four prefs → "no EAS project"
note), a **local notification for a run finished while backgrounded** (needed the new
`fabdesk-background-grace` module — iOS was suspending the socket), and a **supervised run
approved from the phone** (card → Approve → file written → "✓ approved on this phone", daemon
records `by: device`). The AYN Thor has the same build as a release APK. Your iPhone has it as
`com.fabplane.fabdesk` (Voxly team) — a new app next to the old one; trust the team once if iOS
asks, then pair again.

Still open, none blocking: Tailscale `serve` never run against a real config, no relay
deployed, the fabplane.com `/pair` page. Push is live on staging and production (both providers
self-test green, 2026-09-13); the Sentry project `fabplane-mobile` exists and its DSN is being
installed in the EAS environments.

## Still never run

Only a physical device can answer these:

- `expo-camera` QR scanning (`app/connect/scan.tsx`). The simulator has no camera.
- **Mac Catalyst is not a way around the simulator's blank Skia canvas.** Tried 2026-09-13:
  with `mac_catalyst_enabled` and `SUPPORTS_MACCATALYST` on, everything compiles (only
  `expo-camera`'s VisionKit scanner needs a `#if !targetEnvironment(macCatalyst)` guard), but the
  link fails with `library 'pathops' not found` — `@shopify/react-native-skia` ships `ios`,
  `ios-simulator`, `macos` and `tvos` xcframework slices and no `maccatalyst` one. Catalyst
  would need Skia built from source, or a non-Skia cinema renderer for that target.
- Hardware shortcuts on a real keyboard (L1); the iPad detail pane navigation.
- A real background → foreground cycle and a Wi-Fi → cellular switch (T1).
- Double-tap-to-zoom in the board viewer. Pinch and pan were made with real gestures; a double
  tap was not (the driving tool cannot deliver two taps inside the 500 ms window).
- The Android keystore size limit (~2 KB per entry via `SharedPreferences`+keystore) with several
  saved connections. One connection fits; more is untested.
- iOS Local Network permission over a real tailnet vs a real LAN — see the next section. The
  simulator talks to loopback and never triggers the prompt.
- Backgrounding, Wi-Fi ↔ cellular — see "WebSocket lifecycle on a real network".

## The three risks I would test first

### 1. iOS Local Network permission (most likely to block everything)

`app.json` now sets both halves of this, ahead of the first real-phone build:

- `NSLocalNetworkUsageDescription` — on iOS 14+ an app connecting to a bare IP on the local network
  triggers a system permission prompt, and without the usage string the connection fails with no
  visible reason.
- `NSAllowsArbitraryLoads` — `NSAllowsLocalNetworking` alone only exempts RFC 1918 / link-local
  addresses from App Transport Security, and a Tailscale address is CGNAT space
  (`100.64.0.0/10`), so plain HTTP to it would be refused. ATS exceptions are keyed by domain, not
  IP, and the pairing URL carries IPs, so there is no narrower exception that covers the tailnet
  path. (The alternative — MagicDNS names in the pairing URL plus a per-domain exception — would
  work only for tailnets with MagicDNS on; a later refinement.)

Whether a tailnet address also counts as "local network" for the _permission prompt_ is still
open — it may bypass the check entirely, or may not. **Test the tailnet path and the LAN path
separately**; they may behave differently.

Symptom to look for: `findReachable` returns null and the app shows "Can't reach that computer"
even though `curl http://<ip>:47820/health` works from a laptop on the same tailnet.

### 2. Android cleartext

**`android.usesCleartextTraffic` in `app.json` does nothing on Expo SDK 54** — `@expo/config-plugins`
types the manifest attribute but no plugin writes it from the config. The emulator's debug build
still reached `10.0.2.2` because the Expo template's `android/app/src/debug/AndroidManifest.xml`
sets `usesCleartextTraffic="true"` for Metro; the first **release** APK installed on a real device
(an AYN Thor, Android 13) failed every request with `Network request failed`. The flag now comes
from the `expo-build-properties` plugin, which puts it in the main manifest; a release APK on the
Thor pairs and streams with it.

### 3. WebSocket lifecycle on a real network

`packages/client-core/src/ws.ts` was written against fakes. The reconnect path now has a regression
test for the real failure shape (`onerror` then `onclose` — see "Bug found and fixed" below), but
the things a test cannot cover:

- Backgrounding the app and coming back. RN may kill the socket silently. There is **no**
  `AppState` listener yet — if the stream comes back dead after a background/foreground cycle, that
  is the missing piece, and `src/transport/CoreConnection.tsx` is where it goes.
- Switching Wi-Fi → cellular. `findReachable` only runs on mount and on explicit retry, so the app
  will likely sit on a dead base URL. Settings has a **Reconnect** button as the manual escape
  hatch; whether that is enough is a product call.
- Whether the daemon-restart detection actually fires. Kill and restart `fabdesk-core` while the
  phone is connected: the app should refetch rather than silently skip events. The pid check lives
  in `openEvents` in `src/transport/CoreConnection.tsx`.

## Bug found and fixed before the simulator pass

`subscribeWs` retried on **both** `onerror` and `onclose`. A real failing socket fires both, so
every failure doubled the number of sockets being opened and double-incremented the backoff
counter. Fixed with a per-socket `WeakSet` guard, plus a regression test that was confirmed to fail
without the fix. Worth knowing because it is the shape of bug the fake-socket tests were blind to —
**assume there are more of them in the runtime paths listed above.**

## Testing without a phone

The whole server half can be driven with `curl`, and this is the fastest way to confirm a problem
is on the phone side rather than the daemon side.

```bash
# 1. Start a daemon in local mode with a known token.
cd /path/to/fabdesk
FABDESK_TOKEN=dev-token-0123456789 bun run --cwd apps/core src/main.ts serve --port 47810 &

# 2. Turn on the remote listener (bind loopback so nothing hits the network).
curl -s -X PATCH localhost:47810/settings \
  -H 'authorization: Bearer dev-token-0123456789' -H 'content-type: application/json' \
  -d '{"remote":{"enabled":true,"host":"127.0.0.1","port":47820}}' | jq .remote

# 3. Mint a pairing code — this is what the desktop QR encodes.
curl -s -X POST localhost:47810/v1/devices/pair/start \
  -H 'authorization: Bearer dev-token-0123456789' | jq .

# 4. Claim it the way the phone does. No bearer: the pairing token IS the credential.
curl -s -X POST localhost:47820/v1/devices/pair/claim \
  -H 'content-type: application/json' \
  -d '{"pairingToken":"<t from step 3>","label":"Test phone","platform":"ios"}' | jq .

# 5. The device token behaves like a real client from here.
curl -s localhost:47820/projects -H 'authorization: Bearer <deviceToken>' | jq .
```

`websocat "ws://127.0.0.1:47820/ws?topics=agent.*&token=<deviceToken>"` then sending
`{"subscribe":["agent.*"]}` exercises the event stream the app uses. Start an agent run on the
desktop and frames should appear.

## Running the app

```bash
bun run mobile:install     # apps/mobile has its OWN bun.lock — never plain `bun install` inside it
bun run mobile             # expo start
```

`expo-camera` does **not** work in Expo Go on iOS for barcode scanning in all configurations, so
plan on a dev client:

```bash
cd apps/mobile
bunx expo prebuild          # ios/ and android/ are gitignored; regenerate freely
bunx expo run:ios           # or run:android
```

The phone and the computer must be on the same tailnet or LAN. Simulator note: the iOS Simulator
shares the host's network, so a daemon on `127.0.0.1` is reachable at the host's LAN IP, not at
`localhost`. The Android emulator reaches the host at `10.0.2.2`.

## Things to check that are easy to miss

- **Chats tab is empty but the desktop has chats.** Check `GET /threads` with the device token
  first (step 5 above). If the daemon returns them, the problem is `groupThreadsByProject` or the
  `SectionList`, not the transport.
- **Messages do not stream but appear on refresh.** The WebSocket is not delivering.
  `agent.delta` is dropped unless `agent.started` was seen first (the run→thread mapping lives in
  `useRunsStore`), so joining mid-run legitimately shows nothing until the run ends. That is
  inherited desktop behaviour, not a mobile bug — but confirm it is that and not a dead socket.
- **Board image blank.** Almost certainly the `Authorization` header not surviving into
  `expo-image`. Verify by fetching the same URL with `fetch` + the header manually.
- **Pairing says "could not reach".** `claimFirstReachable` tries addresses **sequentially** and on
  purpose — the pairing token is one-time and racing them in parallel would burn it on a loser. With
  several addresses and a 5 s timeout each this can take a while before it gives up. Not a hang.
- **Scanning fires repeatedly.** `app/connect/scan.tsx` guards with a `claimed` ref because the
  scanner re-fires on the same code; if pairing ever double-claims, that guard is what failed.

## If markdown breaks

`react-native-markdown-display` is the weakest dependency. The chat view's only use of it is one
`<Markdown>` element in `src/components/MessageParts.tsx`; the part-grouping logic
(`src/lib/message-blocks.ts`) is separate, pure, and fully tested, so swapping the renderer is a
contained change. Replacing it with plain `<Text>` is a valid stopgap that costs only code-block
and link formatting.

## Where things live

```
apps/mobile/
  app/                        screens (expo-router)
  src/transport/              connection lifecycle, pairing, secure storage — RN-bound
  src/lib/                    pure, unit-tested logic (Bun cannot import react-native, so
                              anything testable must stay free of RN imports — this split is
                              load-bearing, not stylistic)
  src/components/             views
  metro.config.js             aliases @fabdesk/client-core and @fabdesk/protocol to source
packages/client-core/         shared with the desktop; transport, event reducer, queries, stores
apps/core/src/{remote,devices,net}.ts   the daemon half
packages/ui/src/settings/RemoteSection.tsx   the desktop pairing UI
```

`tsconfig.json` and `metro.config.js` both declare the two workspace aliases. **Keep them in step** —
a path added to one and not the other typechecks but fails to bundle, or vice versa.

## Not done, by design

Not bugs, and listed in `docs/mobile.md` too: no attachments on project-less threads (no upload
endpoint exists), no Route Cinema, no 3D viewer, no schematic/PCB SVG, no on-device board rendering,
no app-store or EAS build config, and no entry in the release pipeline. `scripts/set-version.ts` and
`release.yml` deliberately do not know this app exists.
