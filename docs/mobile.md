# Mobile client

`apps/mobile` is an Expo app for iOS and Android that attaches to a fabPlane daemon running on your
computer: your projects and chats, agent runs streaming live, and the board renders. It is built
with EAS, versioned by the release workflow, and reports crashes to Sentry
([mobile-release.md](mobile-release.md)); it is not yet on a store.

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
   fabdesk://pair?v=1&t=<pairingToken>&p=47820&n=<hostname>&h=100.64.0.1&h=192.168.1.24
   ```

   Every address it believes it is reachable on is listed, tailnet (`100.64.0.0/10`) first.
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
- **There is no TLS.** The intended deployment is a Tailscale tailnet, which already encrypts.
  Do not port-forward `47820` to the internet.
- Remote access is off by default and is never enabled by an upgrade.

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
