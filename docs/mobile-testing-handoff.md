# Handoff: testing `apps/mobile` on real devices

For whoever picks this up with a simulator, a device, or an Expo build service. The app was written
and statically verified in a Linux container with **no emulator, no simulator, and no phone** — so
everything below the "Verified" line is genuinely unknown, not merely unpolished.

Read [`docs/mobile.md`](mobile.md) first for what the app is and how pairing works. This document is
only about what to test and what is likely to break.

- **Branch:** `claude/experimental-ios-android-client-l1c8h7`
- **Commits:** `6e99f45` (extract `@fabdesk/client-core`, daemon remote access) → `904b6d3`
  (desktop Remote access + QR pairing) → `2d2914e` (the Expo app)
- **Stack:** Expo SDK 54, React Native 0.81.4, React 19.1, expo-router 6, New Architecture on

## What is actually verified

| Check | How |
|---|---|
| Root `bun install && bun run typecheck && bun run test` green | run; 45 new tests |
| No `react-native`/`expo` in the root install | `ls node_modules` after a clean `--frozen-lockfile` install |
| `apps/mobile` typechecks under the repo's strict settings | `bun run mobile:typecheck` |
| Pure logic unit tests (25) | `bun run mobile:test` |
| **Metro resolves the aliased workspace packages and the app bundles** | `bunx expo export --platform android` → 1639 modules, 4.83 MB |
| Daemon remote listener, pairing, device-token issue/revoke | `apps/core/test/remote.test.ts`, `devices.test.ts` — over real HTTP against a real daemon |

That last row matters: **the server half of this feature is tested end to end.** A phone is not
required to exercise pairing — `curl` against a daemon works, see "Testing without a phone" below.

## What has never run

Everything that needs a device runtime:

- Any screen actually rendering. The bundle builds; no component has been mounted.
- `expo-camera` QR scanning (`app/connect/scan.tsx`).
- `expo-secure-store` read/write (`src/transport/connections.ts`) — including whether connection
  metadata (not just tokens) is happy going through SecureStore, which has a value-size limit on
  Android (~2 KB per entry via `SharedPreferences`+keystore). A few saved connections should fit,
  but this is untested and is the most likely place to hit a surprise.
- `react-native-reanimated` worklets and `react-native-gesture-handler` in the board viewer
  (`app/board/[id].tsx`). Reanimated 4 requires `react-native-worklets`, which is pinned and wired
  into `babel.config.js`, but the plugin ordering has not been proven at runtime.
- `react-native-markdown-display@7.0.2` under React 19 — it is the least maintained dependency here
  and the most likely to need replacing. If it throws, the chat view is the casualty; see
  "If markdown breaks" below.
- `expo-image` carrying an `Authorization` header (`src/components/ProjectImage.tsx`). This is the
  only way the phone can load a board render, since `GET /projects/:id/files/*` takes the bearer in
  a header only and will **not** accept `?token=`.
- The keyboard-avoiding composer on either platform.

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

## Bug found and fixed during this handoff

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
