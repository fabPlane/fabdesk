# Mobile client (experimental)

`apps/mobile` is an Expo app for iOS and Android that attaches to a fabPlane daemon running on your
computer: your projects and chats, agent runs streaming live, and the board renders. It is
**experimental** — not in the release pipeline, not on any store, and run from a dev server.

It exists because everything in fabPlane is local. The daemon spawns `claude`, `codex`, KiCad and
the router as subprocesses on one machine, so the phone is a client of *that machine*, not of
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
   unauthenticated route on the daemon besides `/health` — the pairing token *is* the credential —
   and it is one-time.
4. It gets back a device token of its own, kept in the OS keystore (`expo-secure-store`). The daemon
   stores only a SHA-256 digest, in the `devices` table.

A device token is needed because the daemon's own bearer token is re-minted at every start, so a
phone could never hold it.

Both the pairing addresses and the device token are saved, so a laptop that moves between a tailnet
and a LAN reconnects without re-pairing: `/health` is probed on every known address and the first to
answer wins.

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

`app.json` carries both `NSAllowsArbitraryLoads` and `NSAllowsLocalNetworking`. The narrow key
covers plain HTTP to RFC 1918 / link-local addresses (the LAN path); a tailnet address is CGNAT
space (`100.64.0.0/10`), and ATS exceptions are keyed by domain, not IP, so the wide key is what
lets the `tailscale` kind connect. The phone tries https candidates first, then its last-known-good
address, then the rest, so a served MagicDNS name is used whenever it answers.

`NSAllowsArbitraryLoads` can go once every endpoint a daemon advertises is https — that is, once
`tailscale serve` is required rather than optional for the tailnet path (LAN pairing keeps working
through `NSAllowsLocalNetworking`). Until then dropping it would break pairing over a bare tailnet
IP, which is still the common case.

Testing it on a device: [mobile-testing-handoff.md](mobile-testing-handoff.md). What comes next, in phases and per-agent work packages: [mobile-roadmap.md](mobile-roadmap.md) — what is verified, what has never run, and the platform gotchas to expect.

## Running it

```bash
bun run mobile:install    # apps/mobile keeps its own lockfile
bun run mobile            # expo start — scan with Expo Go or a dev client
```

`bun run mobile:typecheck` and `bun run mobile:test` run the checks CI runs (`.github/workflows/mobile.yml`).

The phone must reach the computer, so put both on the same tailnet (or the same LAN) first.

## Why it is not a workspace

The root `workspaces` list names `apps/core` and `apps/desktop` explicitly rather than globbing
`apps/*`. An Expo dependency tree is ~650 packages; in the root lockfile it would install on every
CI job, on all four release runners, and be combed by the daily `bun audit`. `apps/mobile` therefore
has its own `bun.lock`.

It does not install `@fabdesk/client-core` or `@fabdesk/protocol` either. Both ship raw TypeScript,
so `metro.config.js` aliases them to their source and watches those directories — edits in
`packages/` hot-reload here. `tsconfig.json` mirrors the same two paths for `tsc`.

`scripts/set-version.ts` and `release.yml` do not know about this app, and should not until it is
more than experimental.

## What it shares with the desktop

Everything below the view layer, from `@fabdesk/client-core`: `CoreClient`, the event reducer that
turns `agent.delta` / `agent.tool_use` / `agent.tool_result` into the react-query message cache, the
runs and auth stores, the tool runner, and the query hooks. The screens are the only mobile-specific
code. A fix to streaming or a new endpoint lands in both clients at once.

## Screens

| Route | What it is |
|---|---|
| `(tabs)/index` | Chats — threads grouped by project, pinned first, a dot for a live run |
| `(tabs)/projects` | Projects |
| `(tabs)/settings` | The connection, the core's version, agents detected on that machine |
| `thread/[id]` | The chat: streaming text, collapsible thinking, folded tool groups, Send/Stop |
| `project/[id]` | Board preview, renders, files, and a button to re-render the board |
| `board/[id]` | Full-screen render with pinch, pan and double-tap zoom |
| `connect/*` | Saved computers, QR scanning, pasting a pairing link |

There is no tool-approval UI because there is nothing to approve: agent permissions are a per-agent
setting applied when the subprocess is spawned (`Settings.agents[id].permissionMode`), so tool calls
are notifications. The only interactive control over a run is Stop.

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
