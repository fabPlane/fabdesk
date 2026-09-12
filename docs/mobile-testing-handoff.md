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
emulator reaches it at `10.0.2.2`). Driven through the simulator's accessibility tree, so
**multi-touch (pinch) and the keyboard were not exercised** — see "Still never run".

| Now verified at runtime                                                                                                               | Where                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Every screen mounts and renders under the New Architecture, on both platforms                                                         | all of `app/`                                          |
| Android cleartext HTTP to a bare IP (`10.0.2.2`) on API 34                                                                            | `usesCleartextTraffic` in `app.json`                   |
| Sending from the phone: composer → `POST /threads/:id/messages` → streamed reply (Android)                                            | `app/thread/[id].tsx`                                  |
| Pairing via the `fabdesk://pair` link, sequential address fallback (unreachable LAN address first, then loopback)                     | `app/pair.tsx`, `claimFirstReachable`                  |
| `expo-secure-store` round-trips token + connection metadata across a cold start                                                       | `src/transport/connections.ts`                         |
| WebSocket connects, streams a live run (deltas, tool groups, Stop→Send), reconnects after a daemon restart and refetches (pid change) | `packages/client-core/src/ws.ts`, `CoreConnection.tsx` |
| `react-native-markdown-display` under React 19: bullets, inline code, paragraphs                                                      | `src/components/MessageParts.tsx`                      |
| `expo-image` sends the `Authorization` header — board renders load                                                                    | `src/components/ProjectImage.tsx`                      |
| Reanimated 4 + worklets + gesture-handler load; the board modal opens and closes                                                      | `app/board/[id].tsx`                                   |
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

## Still never run

Only a physical device can answer these:

- `expo-camera` QR scanning (`app/connect/scan.tsx`). The simulator has no camera.
- Pinch-to-zoom in the board viewer. The gesture code loads and pan/double-tap are wired, but no
  two-finger gesture was made.
- The keyboard-avoiding composer on **iOS**. Android was typed into and works (bug 6); on the
  simulator the software keyboard never came up under accessibility-driven input, and the iOS
  branch is unchanged from before the pass.
- The Android keystore size limit (~2 KB per entry via `SharedPreferences`+keystore) with several
  saved connections. One connection fits; more is untested.
- iOS Local Network permission over a real tailnet vs a real LAN — see the next section. The
  simulator talks to loopback and never triggers the prompt.
- Backgrounding, Wi-Fi ↔ cellular — see "WebSocket lifecycle on a real network".

## The three risks I would test first

### 1. iOS Local Network permission (most likely to block everything)

`app.json` sets `NSAllowsLocalNetworking` and a camera usage string, but **not**
`NSLocalNetworkUsageDescription`. On iOS 14+ an app connecting to a bare IP on the local network
triggers a system permission prompt, and without the usage string the connection fails with no
visible reason.

Whether a Tailscale `100.64.0.0/10` address counts as "local network" to iOS is exactly the
question — it is CGNAT space reaching a peer over a userspace tunnel, so it may bypass the check
entirely, or may not. **Test the tailnet path and the LAN path separately**; they may behave
differently.

If it blocks, add to `ios.infoPlist`:

```json
"NSLocalNetworkUsageDescription": "Connecting to fabPlane running on your computer."
```

and, if plain HTTP to an IP is refused outright, widen ATS. Prefer a scoped exception over
`NSAllowsArbitraryLoads` if one works.

Symptom to look for: `findReachable` returns null and the app shows "Can't reach that computer"
even though `curl http://<ip>:47820/health` works from a laptop on the same tailnet.

### 2. Android cleartext

`usesCleartextTraffic: true` is set, which should be enough for HTTP to an IP. Verify on Android 9+
(API 28 changed the default). If it fails, a network security config allowing cleartext to the
tailnet range is the next step.

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
