# Mobile client

`apps/mobile` is an Expo app for iOS and Android that attaches to a fabPlane daemon running on your
computer: your projects and chats, agent runs streaming live, and the board renders. It is built
with EAS, versioned by the release workflow, and reports crashes to Sentry
([mobile-release.md](mobile-release.md)); it is not yet on a store.

It exists because everything in fabPlane is local. The daemon spawns `claude`, `codex`, KiCad and
the router as subprocesses on one machine, so the phone is a client of _that machine_, not of
fabplane.com.

## How it connects

```
 apps/mobile  ──REST + /ws──►  fabdesk-core remote listener  0.0.0.0:47820   opt-in, off by default
                               fabdesk-core local  listener  127.0.0.1:rand  unchanged
                                        │
                                        └─ one Hono app, one SQLite, one job runner
```

Two listeners over one app rather than rebinding the existing one. The loopback listener keeps its
behaviour exactly — MCP's DNS-rebinding allowlist, the strict WebSocket origin check, the
parent-process watchdog. The remote listener serves a narrower app: `/mcp`, `/shutdown` and the
`/v1/devices` administration routes return 404 on it. Turning remote access on or off is a settings
patch; the daemon does not restart.

The phone uses the WebSocket at `/ws`, not the SSE stream at `/events`: React Native has no
`EventSource` and its `fetch` cannot stream a response body.

### Pairing

1. On the desktop: **Settings › Remote access**, turn it on, then **Pair a device**.
2. The daemon mints a one-time pairing token (3 minutes, 5 attempts) and builds a QR payload:

   ```
   fabdesk://pair?v=1&t=<pairingToken>&p=47820&n=<hostname>&h=100.64.0.1&h=192.168.1.24&k=tailscale&k=lan
   ```

   Every address it believes it is reachable on is listed, tailnet (`100.64.0.0/10`) first, with
   a parallel `k=` list of kinds. When the Tailscale CLI is installed the daemon asks it
   (`tailscale status --json`) for the tailnet address and MagicDNS name, and if
   `tailscale serve` fronts the listener (Settings › Remote access › **Tailscale HTTPS › Set up**,
   or `tailscale serve --bg https:443 http://127.0.0.1:47820` by hand) the name leads the list as
   an https endpoint, flagged by a parallel `s=` list that only appears when some host is https:

   ```
   …&h=mac.tail1234.ts.net&h=100.64.0.1&k=tailscale-https&k=tailscale&s=https&s=http
   ```

   An https host is `https://<name>` on 443 — `p=` applies to the http ones. A phone from before
   `s=` reads the name as `http://<name>:47820`, which still works over the tailnet.

3. The phone scans it and `POST /v1/devices/pair/claim`s each address in turn. That route is the one
   unauthenticated route on the daemon besides `/health` — the pairing token _is_ the credential —
   and it is one-time.
4. It gets back a device token of its own, kept in the OS keystore (`expo-secure-store`). The daemon
   stores only a SHA-256 digest, in the `devices` table.

A device token is needed because the daemon's own bearer token is re-minted at every start, so a
phone could never hold it.

Both the pairing addresses and the device token are saved, so a laptop that moves between a tailnet
and a LAN reconnects without re-pairing: `/health` is probed on every known address and the first to
answer wins.

### Several computers

A phone can be paired with any number of computers; each is a `Connection` with its own device
token in the keystore, and exactly one is _active_. Chats, projects and runs are per computer —
switching swaps the transport under the shared provider, and the react-query cache is cleared so
the new computer's list never flashes the old one's threads. The other computer's token is kept, so
switching back is instant.

- **Status.** While the Connections screen or the switcher sheet is open, every saved computer's
  last-known addresses are probed on `/health` (in parallel, 2 s timeout) on arrival and once a
  minute after; pull down on Connections to probe now. The result is a dot: green _Online_, red
  _Offline_, grey _Checking…_. It is kept in memory only (`useEnvironmentStatus` in
  `src/transport/CoreConnection.tsx`) — a status is a snapshot of the network a minute ago and says
  nothing after a relaunch. For the active computer the live stream outranks the probe.
- **Switcher.** The Chats header carries a pill with the active computer's name and dot. It opens a
  sheet listing every computer — status, "last seen" — ordered active first, then online, then by
  last seen; tap one to switch, _Pair another_ at the bottom. The same order and labels are on the
  Connections screen (`src/lib/environments.ts` is the pure part, with tests).
- **Last seen** is the later of the last successful connect and the last probe that answered: it
  is about the computer, not the socket.

### Pairing a browser (hosted web pairing)

The browser client (`packages/ui`, the same React app the desktop runs) can pair with a computer
too, from a link instead of a QR code:

```
https://fabplane.com/pair?host=https://<magicdns-name>#token=<pairingToken>
```

- `host` is the daemon's origin — scheme, host, optional port, nothing after. It travels in the
  query so the page can read it before doing anything.
- `token` is the one-time pairing token (`pairingToken` from `POST /v1/devices/pair/start`, the
  `t=` of the QR payload). It travels in the **fragment**, which browsers never send to the server:
  fabplane.com's logs, its CDN and any `Referer` see the host but never the secret. The page removes
  it from the address bar (`history.replaceState`) before doing anything else.
- **HTTPS only from an HTTPS page.** A browser will not let `https://fabplane.com` fetch
  `http://100.64.0.1:47820` (mixed content), and reports it as a generic network failure; the page
  refuses an `http://` host up front with a message saying why. The intended `host` is therefore a
  Tailscale HTTPS endpoint (`tailscale serve`, MagicDNS name). A plain-`http` page — the Vite dev
  server — may pair with a plain-`http` daemon, which is how it is tested locally.

What the page does (`packages/ui/src/pair/`): parse the link (`parse.ts`), `POST
<host>/v1/devices/pair/claim { pairingToken, label: "<Browser> on <OS>", platform: "web" }` straight
from the browser to the computer (fabplane.com is never in the path), save `{ host, deviceToken,
coreName, coreId, deviceId, pairedAt }` in `localStorage` under `fabdesk.web-hosts` (one key, a list
plus the active host), and hand over to the app, which connects with the device token as its bearer
over the desktop's own `DirectTransport` path. A bare `/pair` — and a boot with no `?core=` and no
active saved computer — shows the **Computers** page: the saved computers with _Use_ / _Remove_;
inside the running app the same list is `ComputersDialog`, opened from the shell (UserFooter ›
Computers). Removing a computer there forgets its token in this browser only; revoking is still
done on the computer under Settings › Remote access, where the browser is listed as a device.

For the fabplane.com site: `/pair` must serve the browser client (`BrowserApp` from `@fabdesk/ui`,
which gates on `location.pathname === "/pair"` at boot), and nothing on the server needs to read the
link. The daemon must also accept the site's origin on its remote listener — its origin guard
(`originAllowed` in `apps/core/src/auth.ts`) currently allows only loopback, `file://` and the
app's own scheme, so `https://fabplane.com` needs adding to `extraOrigins` (the `pair/claim`
preflight goes through that guard too).

### Security

- **A device token can do everything the desktop can.** There is no reduced scope. Revoke one from
  Settings › Remote access; it stops working immediately.
- **The listener itself has no TLS.** The intended deployment is a Tailscale tailnet, which
  already encrypts. Do not port-forward `47820` to the internet. With **Tailscale HTTPS** set up,
  `tailscale serve` terminates TLS on 443 with a certificate the tailnet issues for the MagicDNS
  name (the tailnet's HTTPS certificates feature must be on, in the admin console under DNS) and
  proxies to the listener on loopback — so the listener can even be bound to `127.0.0.1` and
  still be reachable from the tailnet, over HTTPS only.
- Remote access is off by default and is never enabled by an upgrade.

### App Transport Security (iOS)

`app.json` carries `NSAllowsArbitraryLoads` **alone**. It used to carry `NSAllowsLocalNetworking`
too, and that broke the relay on iOS: Apple's rule is that when `NSAllowsLocalNetworking` (or
the media / web-content keys) is present, ATS ignores `NSAllowsArbitraryLoads` — so plain HTTP
was allowed only to addresses iOS considers local (the LAN and, as it turned out, a bare tailnet
IP), and a qualified hostname such as a staging relay on `http://…ts.net:4010` was refused
before a packet left the phone (`NSURLErrorDomain -1022`, which React Native reports as
"Network request failed"). One wide key covers every case the narrow one did.

`NSAllowsArbitraryLoads` can go once every endpoint a daemon advertises is https — that is, once
`tailscale serve` is required rather than optional for the tailnet path and the relay is TLS
(`wss://relay.fabplane.com` is; staging's is not). Until then dropping it would break pairing over
a bare tailnet IP, which is still the common case.

Testing it on a device: [mobile-testing-handoff.md](mobile-testing-handoff.md). What comes next, in phases and per-agent work packages: [mobile-roadmap.md](mobile-roadmap.md) — what is verified, what has never run, and the platform gotchas to expect.

## Running it

```bash
bun run mobile:install    # apps/mobile keeps its own lockfile
bun run mobile            # expo start — scan with Expo Go or a dev client
```

`bun run mobile:typecheck` and `bun run mobile:test` run the checks CI runs (`.github/workflows/mobile.yml`).
`apps/mobile/e2e/run.sh` runs the Maestro pairing-and-chat flow against a simulator, and
`scripts/mobile-screenshots.sh` captures the main screens ([mobile-release.md](mobile-release.md)).

The phone must reach the computer, so put both on the same tailnet (or the same LAN) first.

## Why it is not a workspace

The root `workspaces` list names `apps/core` and `apps/desktop` explicitly rather than globbing
`apps/*`. An Expo dependency tree is ~650 packages; in the root lockfile it would install on every
CI job, on all four release runners, and be combed by the daily `bun audit`. `apps/mobile` therefore
has its own `bun.lock`.

It does not install `@fabdesk/client-core` or `@fabdesk/protocol` either. Both ship raw TypeScript,
so `metro.config.js` aliases them to their source and watches those directories — edits in
`packages/` hot-reload here. `tsconfig.json` mirrors the same two paths for `tsc`.

`scripts/set-version.ts` stamps `app.json` (version and both native build numbers) alongside the
package.json files, and `release.yml` has a `mobile` job that checks the app and, given an
`EXPO_TOKEN`, queues an EAS preview build. Details in [mobile-release.md](mobile-release.md).

## What it shares with the desktop

Everything below the view layer, from `@fabdesk/client-core`: `CoreClient`, the event reducer that
turns `agent.delta` / `agent.tool_use` / `agent.tool_result` into the react-query message cache, the
runs and auth stores, the tool runner, and the query hooks. The screens are the only mobile-specific
code. A fix to streaming or a new endpoint lands in both clients at once.

## Screens

| Route             | What it is                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `(tabs)/index`    | Chats — threads grouped by project, pinned first, a dot for a live run        |
| `(tabs)/projects` | Projects                                                                      |
| `(tabs)/settings` | The connection, the core's version, agents detected on that machine           |
| `thread/[id]`     | The chat: streaming text, collapsible thinking, folded tool groups, Send/Stop |
| `project/[id]`    | Board preview, renders, files, and a button to re-render the board            |
| `board/[id]`      | Full-screen render with pinch, pan and double-tap zoom                        |
| `connect/*`       | Saved computers, QR scanning, pasting a pairing link                          |

### Supervised mode, approvals and questions

A thread runs in one of two runtime modes (`Thread.runtimeMode`, default from
`Settings.defaultRuntimeMode`): **full** — tool calls are notifications, Stop is the only
control — or **supervised** — the agent pauses before anything that writes and asks. The daemon
decides what pauses (`apps/core/src/supervision.ts`: native shells and file edits always, fabdesk
tools unless they are read-only or idempotent, reads never) and emits `agent.approval_requested`;
the desktop and the phone both show a card with Approve / Deny, and `POST
/threads/:id/approvals/:requestId` resolves it (device tokens are accepted, credited
`by: "device"`). A request nobody answers in 30 minutes is denied and the run continues. Agents
that ask the user a question (`AskUserQuestion`) surface as `agent.input_requested` with option
buttons or a text field. Only Claude Code can run supervised today (`--permission-mode manual`
plus the daemon's `permission_prompt` MCP tool); Codex/grok/cursor report
`supportsSupervised: false` and the mode switch is disabled for them.

While a run is live, **Queue** stores a message (`?queue=1`) that the daemon sends when the run
ends; it shows dimmed in the timeline until then. Slash commands (`/render`, `/route`, `/drc`,
`/erc`, `/export …`, `/build`) run a tool directly, without the agent, and report into Jobs.

### Notifications

The phone shows a local notification when a run finishes, fails or needs an answer while the app
is in the background and its socket is still alive. Push — for when the socket is gone — is
designed in [mobile-notifications.md](mobile-notifications.md): the phone registers its native
APNs or FCM device token with each paired daemon (`PUT /v1/devices/me/push`, `tokenKind`
`"apns" | "fcm"`), and the daemon posts to fabplane.com's `POST /v1/private/push`, which
delivers through APNs/FCM directly. The phone side, the daemon side and the route exist; the
backend's provider credentials are the remaining piece.

## Known limits

- **Attachments.** A photo can only be attached to a chat that has a project, because
  `POST /projects/:id/sketches` is the only endpoint that accepts bytes. Project-less threads would
  need a new upload endpoint.
- **Event replay is bounded.** The daemon keeps 500 events per topic and renumbers from zero when it
  restarts. The app watches `/health`'s pid and refetches instead of resuming when it changes, but a
  long routing run watched from a phone that was asleep will have gaps in its frames.
- **No Route Cinema, no 3D, no schematic/PCB SVG.** Cinema needs a canvas; `CinemaPainter` in
  `packages/ui/src/board/cinema/renderer.ts` is already pure maths over an injectable 2D context and
  is the natural target for `react-native-skia`.
- **Renders come from the host.** Drawing the board on-device is the follow-up — `fab_pcb` has
  `@fp-pcb/renderer` (PixiJS) and `kicad-wasm` to build on.

## Adding a proxy backend later

`CoreTransport` in `packages/client-core/src/transport.ts` is the seam. `DirectTransport` is the
only implementation today:

```ts
export interface CoreTransport {
  readonly id: string;
  readonly kind: "direct" | "proxy";
  baseUrl(): string;
  authHeaders(): Record<string, string>;
  client(): CoreClient;
  openEvents(opts: EventStreamOptions): SseSubscription;
  dispose(): void;
}
```

A relay implementation supplies a different base URL, a different credential and a different socket
URL. Nothing above it — the screens, the queries, the event reducer — needs to change. What a relay
still has to settle: how a daemon registers with it, how a device proves itself to the relay as well
as to the daemon, and whether the daemon dials out (so it needs no inbound port at all).

### The relay from the daemon's side

`apps/core/src/relay.ts` is that implementation's daemon end (the relay itself is `apps/relay`,
hosted by fabplane.com). Nothing needs configuring:

- The relay is derived from the fabplane API origin — `https://api.fabplane.com` →
  `wss://relay.fabplane.com`. `FABPLANE_RELAY_URL` overrides it (empty means "no relay"); for an
  origin with no derivable relay (staging's Tailscale name) the daemon also asks
  `GET <api>/v1/config` for `{ relayUrl }` and uses that once the API publishes one.
  `Settings.remote.relayUrl` is the explicit per-daemon override.
- `Settings.remote.relay` is `auto` (absent) or `off`. In `auto` the link is up whenever remote
  access is on and the daemon is signed in; `fabdesk-core serve --relay off` persists the switch.
- `GET /v1/remote` → `relay: { connected, url, since?, error?, lastError? }` (`null` when off;
  `error` is why it is not dialing — "not signed in", "remote access is off" — and `lastError`
  the last socket drop). `GET /health` → `relay: "connected" | "connecting" | "off"`, nothing
  more, as that route is unauthenticated. The bus emits `remote.relay` on every connect and drop.
- The pairing URL lists the relay endpoint only while the link is actually up; `fabdesk-core
pair` prints "Reachable from anywhere via fabplane.com relay" or the reason it is not.
- Each device row records `via: "direct" | "relay"` from its last authenticated request or
  event socket (`fabdesk-core devices` shows the column). Redials back off from 1 s to a hard
  60 s cap and reset on success.
