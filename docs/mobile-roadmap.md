# Mobile roadmap — from v0.1 to a real fabPlane client

Written 2026-09-12 after the first version ran on an iPhone 17 Pro Max and an AYN Thor. This is
the feature map for what comes next, in phases, cut into work packages that separate agents can
take without stepping on each other. Read [`mobile.md`](mobile.md) for what the app is and
[`mobile-testing-handoff.md`](mobile-testing-handoff.md) for what has been verified.

Two sources fed this: an inventory of what fabPlane already has (desktop, daemon, tools) and a
read of **T3 Code** (`~/projects/ai/t3code`, v0.0.40), whose `apps/mobile` is the most complete
"phone client for a local agent daemon" we know of. T3 is a coding-agent GUI; fabPlane is an
EDA tool with agents inside it, so not everything carries over — the table in §2 says what does.

---

## 1. Where v0.1 stands

### On the phone today (`apps/mobile`)

| Area       | Have                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection | QR + link pairing, `fabdesk://pair` deep link, saved computers, sequential address fallback, SecureStore tokens, reconnect on daemon restart (pid check), manual Reconnect, human-readable pairing failures |
| Chats      | Threads grouped by project, pinned first, live-run dot, search, pull-to-refresh, **new chat** (per project header, picker, project screen)                                                                  |
| Thread     | Streaming text, collapsible thinking, folded tool groups with inputs/results, markdown, Send/Stop, keyboard-avoiding composer (both platforms), landscape + wide-screen width cap                           |
| Projects   | List, detail (board preview, renders, file list, re-render), full-screen render with pinch/pan                                                                                                              |
| Settings   | Connection status, core version/uptime, agents detected on that machine, Reconnect / Connections                                                                                                            |
| Platform   | iOS 26 + Android 13 release builds, adaptive icon, Local Network + ATS plist, cleartext on Android, edge-to-edge                                                                                            |

### On the desktop but not on the phone (`packages/ui`)

Board panel tabs **Renders / SVG (schematic + PCB) / 3D (GLB) / DRC / Files**; **Route Cinema**
(`board/cinema`, pure-maths painter over a 2D context); **agent + model menu** per thread;
**thread actions** (rename, pin, archive, delete, branch); **project picker** for a new chat;
**SketchPad** (draw/attach an image to a project thread); **open-source catalog** browse + remix;
**Order flow** (quote → order a board); **command palette**; **fabplane.com login** (`/v1/auth`);
**update badge**; **Settings** (agents, permission mode per agent, default agent, FabPlane PCB
bridge URL, remote access + devices).

### What the daemon already serves that the phone does not use

`GET /projects/:id/route-runs`, `GET /route/runs/:id`, `/frames` (cinema data);
`GET /projects/:id/sketches`, `POST …/sketches` (image upload — project threads only);
`PUT /projects/:id/files/*` (write a file); `GET /search`; `GET /jobs`, `/jobs/:id`, `POST
/jobs/:id/cancel`; `GET /opensource`, `/opensource/preview/…`, `POST …/remix`;
`GET/POST /projects/:id/order`; `PATCH /threads/:id` (title, pinned, archived, agentId, model);
`DELETE /threads/:id`; `POST /projects`, `PATCH /projects/:id`, `DELETE /projects/:id`; folders
(`/folders`); `GET /settings`, `PATCH /settings`; `/v1/auth/*`; `/v1/devices` (local listener only).

Tools an agent can run on that machine (visible as tool cards on the phone already):
`circuit_build/query/search_parts/read_errors`, `render_board/glb/pcb_svg/schematic_svg`,
`route_run/scope/cancel`, `export_gerbers/drill/bom/pos/netlist/dxf/zip`, `kicad_stats`,
`project_*`, and the `app_*` desktop-automation tools.

### Known gaps found on devices (carry into Phase 1)

- No `AppState` handling: background → foreground may come back with a dead socket.
- `findReachable` runs only on mount/retry; a Wi-Fi ↔ cellular switch leaves a dead base URL.
- The daemon titles a thread from its first message and `POST /threads` creates one without
  emitting `thread.updated` / `thread.created`, so other clients only learn on refetch.
- Gboard on the AYN Thor ignores `IME_FLAG_NO_FULLSCREEN` in landscape (device quirk; works via
  DONE → Send).
- Double-tap-to-zoom unverified; iOS Local Network prompt behaviour on a tailnet vs LAN unverified;
  Personal-Team signing expires after 7 days.

---

## 2. What T3 Code's mobile app does, and what carries over

T3's `apps/mobile` (Expo, ~295 source files) is organised into feature modules. Read against
fabPlane:

| T3 mobile feature                      | What it is                                                                                                                                                                              | fabPlane?                                                                                         | Phase          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| Environments + pairing (`connection/`) | Many saved "environments", each with several `AccessEndpoint`s (LAN, Tailscale IP, MagicDNS HTTPS, tunnel); status dot per environment; onboarding                                      | Yes — we have one-computer-at-a-time; multi-computer and endpoint kinds are the natural extension | 4              |
| Home list (`home/`)                    | Threads sorted by last message/created; group by repository / path / none; filters                                                                                                      | Partly have; sorting and filters                                                                  | 1              |
| Thread detail + feed (`threads/`)      | Streaming feed, work log, composer with **model** and **configuration** pickers, command popover (slash commands), draft screen for a new task with **environment / workspace / model** | Yes — agent+model picker, slash commands, drafts                                                  | 1, 3           |
| Pending approval card                  | In-app approve/deny of a command or file write when the session runs "supervised"                                                                                                       | Only once the daemon has a supervised mode; today permissions are per-agent at spawn              | 3              |
| Pending user-input card                | Agent asks a question with options; "or type a custom answer"                                                                                                                           | Yes, when the adapters surface it                                                                 | 3              |
| Git controls (`threads/git/`)          | Branches, commit, PR status, overview sheets, action progress overlay                                                                                                                   | Projects are KiCad dirs; git is optional. **Later**, only if projects become git-backed           | later          |
| Review (`review/`, `diffs/`)           | Native diff viewer of a turn's file changes, review comments                                                                                                                            | For us the "diff" is the board: before/after renders, DRC delta. Text-file diffs matter less      | 2 (board diff) |
| Files (`files/`)                       | File tree browser, source viewer with syntax highlighting (shiki), markdown/image/web previews                                                                                          | Yes — project files, `circuit.tsx`, reports, renders                                              | 2              |
| Terminal (`terminal/`)                 | Native terminal surface attached to a thread; open new shell                                                                                                                            | Nice-to-have; the daemon has no PTY route. Defer                                                  | later          |
| Agent awareness (`agent-awareness/`)   | **Push notifications** when a turn needs you / finishes, **Live Activities** on iOS, notification → thread navigation, device registration with a relay                                 | Yes — the headline reason to have a phone client                                                  | 3              |
| Archive (`archive/`)                   | Archived threads screen                                                                                                                                                                 | Yes (daemon already has `archived`)                                                               | 1              |
| Cloud (`cloud/`)                       | Clerk auth, managed relay (DPoP tokens), waitlist                                                                                                                                       | We have fabplane.com auth already; a relay is Phase 4                                             | 4              |
| Keyboard (`keyboard/`)                 | Hardware-keyboard shortcuts (iPad, Thor)                                                                                                                                                | Small; Thor and iPad both benefit                                                                 | 2              |
| Layout (`layout/`)                     | Adaptive sidebar + detail on wide screens (iPad), inspector pane                                                                                                                        | Yes — Thor is 538 dp wide, iPad wider                                                             | 2              |
| Projects (`projects/`)                 | Add project: local path / repository / destination                                                                                                                                      | Yes — create project, import KiCad, remix from catalog                                            | 2              |
| Settings (`settings/`)                 | Appearance (theme), auth, environments                                                                                                                                                  | Yes                                                                                               | 1              |
| Observability                          | Tracing hooks                                                                                                                                                                           | Sentry is already in desktop/core; add to mobile                                                  | 5              |

T3 architecture ideas worth borrowing outright (their `docs/architecture/remote.md`):

- **Access vs launch.** How the phone reaches a daemon (direct, tunnel, SSH-forward) is separate
  from how the daemon got started. Our `CoreTransport` seam is the right place; keep it.
- **`AdvertisedEndpoint` with kinds** (loopback / lan / private / public / tunnel) and a stable
  user preference _by kind_, not by IP. Our pairing URL already lists hosts tailnet-first; the
  next step is kinds + a chosen default on the desktop.
- **Tailscale as an endpoint provider**, including MagicDNS HTTPS via `tailscale serve` — that is
  how they get TLS without shipping certificates, and it is how the hosted HTTPS web app can
  reach a home machine. It would also let us drop `NSAllowsArbitraryLoads`.
- **One-time pairing token → session credential** (we have it), plus `t3 auth`-style revocation
  from the CLI (we have devices revoke on the desktop; add to `fabdesk-core` CLI).

Not borrowing: Effect-TS runtime, event-sourced orchestration, checkpoints-as-git-refs, worktrees.
Our daemon is Hono + SQLite + a job runner and that is fine at this scale.

---

## 3. Phases

Each phase is a shippable state. Later phases assume earlier ones.

### Phase 1 — "Use it every day" (v0.2)

Reliability and parity with the desktop for chats. No new surfaces.

1. **Lifecycle**: `AppState` foreground → re-probe + resubscribe; network-change listener
   (`expo-network`) → re-run `findReachable`; backoff cap with jitter; a "stale" banner after N s.
2. **Events the daemon is missing**: emit `thread.created`, `thread.updated` on title change,
   `thread.deleted`; desktop + phone both stop needing refetch for these.
3. **Thread actions**: rename, pin, archive, delete, branch — swipe actions + a `…` menu; archived
   list screen.
4. **Agent + model picker** on the composer and in the new-chat picker (`/agents` lists models;
   `PATCH /threads/:id` switches). Default from settings; remember last used.
5. **Attachments**: camera / photo → `POST /projects/:id/sketches` → sent as `attachments`
   (project threads only; say so in the UI for project-less threads).
6. **Chats list**: sort (last message / created), collapse per project, running-first, unread dot
   (last-seen per thread in local storage).
7. **Pairing pre-flight**: probe `/health` on every address _before_ claiming so an iOS Local
   Network prompt or a wrong network costs nothing; on iOS trigger the prompt on the Connections
   screen (a throwaway local request) with an explanation.
8. **Settings**: appearance (system / light / dark), default agent (writes `PATCH /settings`),
   haptics toggle, "keep screen awake while a run is live".
9. **Desktop remote-access UX**: show endpoint kinds, let the user pick the default that goes in the
   QR (T3's "+N endpoints" pattern), warn when only loopback is advertised.
10. **Fix the known device gaps** listed in §1.

### Phase 2 — "The board on your phone" (v0.3)

Everything the desktop Board panel shows, read-only, plus files.

1. **Renders gallery** with before/after of the last run (the phone's version of T3's review diff).
2. **Schematic + PCB SVG** viewer (`render_schematic_svg` / `render_pcb_svg` output via
   `/projects/:id/files/*`) — `react-native-svg` or a WebView with pinch/pan; layer toggles.
3. **3D**: GLB via `expo-gl` + three or a WebView `<model-viewer>`; both are "load a file the
   daemon already rendered".
4. **DRC tab**: parse `reports/` the same way `DrcTab.tsx` does; tap a violation → highlight on
   the render (needs coordinates from the report; desktop already maps them).
5. **Files**: tree browser, text viewer with syntax highlighting, markdown/image preview; edit +
   `PUT /projects/:id/files/*` behind a confirmation (agents write files; humans rarely need to).
6. **Route Cinema**: `CinemaPainter` is pure maths over an injectable 2D context → port onto
   `@shopify/react-native-skia`; play a finished route run from `/route/runs/:id/frames`; live
   frames over the WebSocket while routing.
7. **Jobs**: a jobs sheet (render, route, export) with cancel; long-running tool cards link to it.
8. **Projects**: create (blank / template), import from the open-source catalog (`/opensource`,
   remix), delete; folder grouping.
9. **Wide-screen layout**: sidebar + detail on iPad / Thor landscape; hardware-keyboard shortcuts.

### Phase 3 — "It taps you on the shoulder" (v0.4)

The reason to carry the app in your pocket.

The full design — contracts for the daemon, the phone and the fabplane.com forwarder — is in
[`mobile-notifications.md`](mobile-notifications.md).

1. **Local notifications** (no server needed): while the app is backgrounded but the socket is
   alive, notify on run finished / failed / needs input. Cheap first step.
2. **Push notifications** (APNs / FCM): needs a relay the daemon can reach out to — the same
   relay Phase 4 builds. Register device tokens with the daemon; the daemon posts to the relay on
   `agent.completed` / `agent.needs_input`. Deep-link into the thread.
3. **iOS Live Activity** for a live run (elapsed, current tool, Stop) — T3 has this.
4. **Supervised runtime mode** (daemon + adapters): a per-thread approval mode where tool calls
   pause for approve/deny; the phone gets a pending-approval card. This is a real daemon feature,
   not a UI one — today permissions are fixed at spawn per agent.
5. **Pending user-input card**: when an adapter surfaces a question with options.
6. **Queue a message** while a run is live (T3's "bigger thing"); sent when the run ends.
7. **Slash commands** in the composer (`/render`, `/route`, `/drc`, `/export gerbers`) that map to
   tool runs without going through the agent.
8. **Thread work log**: a compact "what happened" summary per turn (files written, renders,
   exports) — the tool cards already have the data.

### Phase 4 — "Reach it from anywhere" (v0.5)

The `CoreTransport` seam pays off.

1. **Tailscale endpoint provider on the desktop**: detect tailnet IP + MagicDNS; optional
   `tailscale serve` → HTTPS MagicDNS endpoint; the pairing URL carries endpoint kinds. With HTTPS
   available, tighten ATS again (drop `NSAllowsArbitraryLoads`).
2. **Relay transport** (`kind: "proxy"`): the daemon dials out to a relay (so no inbound port),
   the phone connects to the relay with a device credential, frames are forwarded. Reuse fabplane.com
   auth (`/v1/auth`) for the relay identity. This is also the push-notification path.
3. **Multiple computers**: environments list with status dots, switch without re-pairing, per-
   environment threads in the Chats list (T3's "group by environment").
4. **Hosted web pairing** (`fabplane.com/pair?host=…#token=…`) for the browser client, HTTPS only.
5. **`fabdesk-core` CLI**: `serve --remote`, `devices list/revoke`, print a QR in the terminal for
   headless machines (T3's `t3 serve`).

### Phase 5 — "Shippable"

1. **EAS Build** profiles (dev / preview / production), TestFlight + Play internal track; signing
   under the company team; `scripts/set-version.ts` and `release.yml` learn about the app.
2. **Sentry** on mobile (desktop/core already have it); crash-free-sessions as the release gate.
3. **E2E**: Maestro flows for pair → chat → render on both simulators in CI (the handoff doc's
   manual script, automated); the `apps/core/test/remote.test.ts` style daemon fixture reused.
4. **Store assets**: icon set, screenshots, privacy manifest (`PrivacyInfo.xcprivacy`), Play data
   safety form; the Local Network + camera usage strings reviewed.
5. **Docs**: user-facing pairing guide; `docs/mobile.md` promoted from "experimental".

---

## 4. Work packages, per agent

Each package is sized for one agent working a branch off
`claude/experimental-ios-android-client-l1c8h7` (or its successor). "Touches" is the conflict
map — two packages that touch the same files should not run at the same time. Every package ends
with `bun run typecheck && bun run test && bun run mobile:typecheck && bun run mobile:test` green
and, where it changes a screen, a simulator screenshot in the PR.

### Lanes

- **T — Transport & daemon** (`packages/client-core`, `apps/core`, `apps/mobile/src/transport`)
- **C — Chat** (`apps/mobile/app/(tabs)/index.tsx`, `app/thread`, `src/components/MessageParts*`)
- **B — Board & files** (`app/project`, `app/board`, new `app/files`, `src/lib/renders`)
- **N — Notifications & awareness** (new `src/notifications`, daemon events)
- **D — Desktop** (`packages/ui/src/settings/RemoteSection.tsx`, `apps/core/src/net.ts`)
- **R — Release & QA** (`.github/workflows`, `eas.json`, `apps/mobile/e2e`)

### Wave 1 (Phase 1; all parallel except where noted) — **landed 2026-09-13**

| ID  | Package                                                                               | Lane | Touches                                                                                       | Depends on              | Done when                                                                                                     |
| --- | ------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| T1  | AppState + network-change reconnect; jitter; stale banner                             | T    | `CoreConnection.tsx`, `connect.ts`, `ws.ts`                                                   | —                       | Background 60 s → foreground shows `open` within 3 s; Wi-Fi → cellular re-probes; unit tests with fake timers |
| T2  | Daemon emits `thread.created/updated/deleted`; client-core reducer invalidates        | T    | `apps/core/src/http/app.ts`, `agent-runs.ts`, `client-core/src/events.ts`                     | —                       | Desktop + phone show a new thread / new title with no refetch; `remote.test.ts` covers the events             |
| T3  | Pairing pre-flight (`/health` probe before claim) + iOS Local Network warm-up         | T    | `client-core/src/pairing.ts`, `app/connect/*`                                                 | —                       | Scanning on the wrong network never burns a token; prompt appears on Connections screen                       |
| C1  | Thread actions: rename / pin / archive / delete / branch; archived screen             | C    | `app/thread/[id].tsx` header menu, new `app/archived.tsx`, `(tabs)/index.tsx` swipe           | T2 (nice, not required) | All five actions work and reflect on the desktop                                                              |
| C2  | Agent + model picker (composer + new chat); default from settings                     | C    | `app/thread/[id].tsx`, `app/new-chat.tsx`, `src/hooks/new-chat.ts`                            | —                       | Switching agent mid-thread patches the thread; models come from `/agents`                                     |
| C3  | Attachments: camera / library → sketches → message                                    | C    | `app/thread/[id].tsx` composer, new `src/transport/upload.ts`                                 | —                       | A photo sent from a project thread appears in the run's input; project-less threads explain why not           |
| C4  | Chats list: sort, per-project collapse, unread dot, running-first                     | C    | `(tabs)/index.tsx`, new `src/lib/chat-list.ts` (pure, tested)                                 | —                       | Pure sorting/grouping logic 100% unit-tested                                                                  |
| D1  | Desktop Remote access: endpoint kinds, default endpoint choice, loopback-only warning | D    | `RemoteSection.tsx`, `apps/core/src/net.ts`, `protocol/src/devices.ts` (payload gains `kind`) | —                       | QR carries the chosen default first; `parsePairingUrl` stays backward compatible                              |
| S1  | Settings: appearance, default agent, haptics, keep-awake                              | C    | `(tabs)/settings.tsx`, `src/theme.ts`                                                         | —                       | Theme switch is immediate; default agent persists to the daemon                                               |

Conflict notes: C1 and C2 both edit the thread header — run C2 first or agree on a `ThreadHeader`
component up front. T2 changes `events.ts` which C1 reads; land T2 first if both are in flight.

### Wave 2 (Phase 2) — **landed 2026-09-13** (see `mobile-testing-handoff.md` for what was verified on devices)

| ID  | Package                                                                                              | Lane | Touches                                                                                             | Depends on | Done when                                                      |
| --- | ---------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| B1  | Renders gallery + before/after of the last run                                                       | B    | `app/project/[id].tsx`, new `app/renders.tsx`, `src/lib/renders.ts`                                 | —          | Swipe between renders; "since last run" compare                |
| B2  | SVG viewer (schematic + PCB) with pinch/pan and layer toggles                                        | B    | new `app/svg/[id].tsx`, `src/components/SvgViewer.tsx`                                              | —          | 2-layer board SVG pans at 60 fps on the iPhone; layers toggle  |
| B3  | 3D GLB viewer                                                                                        | B    | new `app/three/[id].tsx`                                                                            | —          | Orbit + zoom; falls back to a message when no GLB              |
| B4  | DRC tab: parse reports, list, tap → highlight                                                        | B    | new `app/drc/[id].tsx`, `src/lib/drc.ts` (pure, tested; port from `DrcTab.tsx`)                     | B1         | Violation list matches the desktop for the same project        |
| B5  | Files: tree, viewer (shiki or `react-native-code-highlighter`), markdown/image preview, guarded edit | B    | new `app/files/*`, `src/lib/file-tree.ts` (pure, tested)                                            | —          | Browse `blinky`, open `circuit.tsx`, preview `renders/top.png` |
| B6  | Route Cinema on Skia                                                                                 | B    | new `app/cinema/[runId].tsx`, `packages/ui/src/board/cinema/renderer.ts` (extract to `client-core`) | —          | Plays a finished run from frames; live frames while routing    |
| B7  | Jobs sheet + cancel; tool cards link to jobs                                                         | B/C  | new `app/jobs.tsx`, `MessageParts.tsx`                                                              | —          | A running render shows in Jobs and can be cancelled            |
| B8  | Projects: create / import from catalog / delete; folders                                             | B    | `(tabs)/projects.tsx`, new `app/new-project.tsx`, `app/catalog/*`                                   | —          | Remix a catalog board from the phone and see it on the desktop |
| L1  | Wide-screen layout (sidebar + detail) and hardware keyboard shortcuts                                | C    | `app/_layout.tsx`, `(tabs)/_layout.tsx`, new `src/layout/*`                                         | —          | iPad and Thor landscape show list + detail; ⌘N / ⌘K work       |

B2/B3/B6 are independent and heavy; give each its own agent. B4 depends on B1 only for the
highlight overlay — the list can land first.

### Wave 3 (Phase 3)

| ID  | Package                                                                            | Lane | Touches                                                                                                            | Depends on | Done when                                                                           |
| --- | ---------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| N1  | Local notifications on run finished / failed / needs input                         | N    | new `src/notifications/local.ts`, `CoreConnection.tsx`                                                             | T1         | Backgrounded app notifies within 2 s of `agent.completed`; tapping opens the thread |
| N2  | Daemon: device push registration + outbound notify hook (relay-agnostic interface) | N/T  | `apps/core/src/devices.ts`, `http/app.ts`, `protocol`                                                              | —          | `POST /v1/devices/:id/push` stores a token; `agent.completed` calls the hook; tests |
| N3  | iOS Live Activity for a live run                                                   | N    | new native module or `expo-live-activity`, `src/notifications/live.ts`                                             | N1         | Elapsed + current tool on the lock screen; Stop works                               |
| A1  | Daemon: supervised runtime mode (tool calls pause for approval)                    | T    | `packages/agents/*` adapters, `apps/core/src/agent-runs.ts`, `protocol` events `agent.approval_requested/resolved` | —          | Claude + Codex adapters honour it; desktop shows a card; `agents` tests             |
| A2  | Pending approval + pending user-input cards on the phone                           | C    | `MessageParts.tsx`, `src/components/PendingApproval.tsx`                                                           | A1         | Approve/deny from the phone resumes the run                                         |
| C5  | Queue a message while a run is live                                                | C/T  | `app/thread/[id].tsx`, `client-core/src/queries.ts`, daemon `POST /threads/:id/messages?queue=1`                   | —          | Queued message sends on completion; visible as "queued"                             |
| C6  | Slash commands → tool runs                                                         | C    | `src/lib/slash-commands.ts` (pure, tested), composer popover                                                       | B7         | `/render top`, `/route`, `/export gerbers` run without the agent                    |
| C7  | Per-turn work log summary                                                          | C    | `src/lib/work-log.ts` (pure, tested), `MessageParts.tsx`                                                           | —          | "3 files written, 1 render, 1 export" line under each turn                          |

A1 is the largest single package and is daemon-side; start it in Wave 2 so A2 can land in Wave 3.

### Wave 4 (Phase 4)

| ID  | Package                                                                       | Lane | Touches                                                                                                 | Depends on | Done when                                                                     |
| --- | ----------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| D2  | Tailscale endpoint provider (IP, MagicDNS, `tailscale serve` HTTPS)           | D    | `apps/core/src/net.ts`, new `tailscale.ts`, `RemoteSection.tsx`                                         | D1         | An HTTPS MagicDNS endpoint appears when serve is configured; QR prefers it    |
| T4  | HTTPS-only ATS when an HTTPS endpoint exists; keep HTTP for LAN               | T    | `app.json`, `pairing.ts`                                                                                | D2         | `NSAllowsArbitraryLoads` gone; LAN still works via `NSAllowsLocalNetworking`  |
| T5  | Relay transport (`ProxyTransport`): daemon dials out, phone connects to relay | T    | new `packages/client-core/src/proxy-transport.ts`, `apps/core/src/relay.ts`, a relay service (own repo) | N2         | A phone on cellular reaches a home daemon with no inbound port                |
| T6  | Multiple environments: list, status, switch, per-environment threads          | T/C  | `src/transport/connections.ts`, `(tabs)/index.tsx`, `app/connect/*`                                     | T1         | Two computers paired; switching keeps both sets of threads                    |
| D3  | `fabdesk-core` CLI: `serve --remote`, `devices`, terminal QR                  | D    | `apps/core/src/main.ts`, `cli/*`                                                                        | D1         | Headless Mac mini pairs a phone from an SSH session                           |
| W1  | Hosted web pairing on fabplane.com (HTTPS backends only)                      | D    | `apps/web` (public site), `packages/ui`                                                                 | D2         | `fabplane.com/pair?host=…#token=…` saves an environment in the browser client |

### Wave 5 (Phase 5)

| ID  | Package                                                                          | Lane | Touches                                                                     | Depends on | Done when                                                                 |
| --- | -------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| R1  | EAS profiles, company signing, TestFlight + Play internal                        | R    | `apps/mobile/eas.json`, `app.json`, `.github/workflows/mobile.yml`          | —          | A tagged build reaches TestFlight from CI                                 |
| R2  | Sentry on mobile                                                                 | R    | `apps/mobile/src/observability.ts`, `app/_layout.tsx`                       | —          | A thrown error in a screen shows in Sentry with the daemon version tagged |
| R3  | Maestro E2E: pair → new chat → send → render on iOS + Android simulators in CI   | R    | `apps/mobile/e2e/*`, `mobile.yml`, daemon fixture from `remote.test.ts`     | T3, C2     | CI runs the flow on both simulators on every mobile PR                    |
| R4  | Store assets, privacy manifest, Play data safety                                 | R    | `apps/mobile/assets/*`, `ios/PrivacyInfo.xcprivacy` via config plugin       | R1         | App Review submission checklist complete                                  |
| R5  | Release pipeline: `set-version.ts`, `release.yml` include the app; docs promoted | R    | `scripts/set-version.ts`, `.github/workflows/release.yml`, `docs/mobile.md` | R1         | One version bump covers desktop, core and mobile                          |

### Suggested agent assignment for the first sprint

Six agents, one lane each, all starting from the same commit:

1. **Transport**: T1 → T3 → (Wave 2) T4 prep.
2. **Chat A**: C2 → C1 → C4.
3. **Chat B**: C3 → S1 → C7.
4. **Daemon**: T2 → N2 → A1 (long).
5. **Desktop**: D1 → D2 → D3.
6. **Board**: B1 → B5 → B2.

A seventh, **QA/Release**, can start R3 immediately against the current app (the manual script in
the handoff doc is the spec) and pick up R1 once signing is decided.

---

## 5. Explicitly not planned

- Drawing the board on-device from KiCad data (the daemon renders; `fab_pcb`'s renderer is the
  eventual path, not this roadmap).
- Git worktrees / branches / PRs as first-class objects (T3's model; our projects are not
  necessarily repos).
- A terminal in the app (no PTY route in the daemon; revisit if agents' shells need watching).
- Running agents on the phone. The phone is a client of one machine; that is the design.

## 6. Open questions to settle before Wave 3

- **Relay ownership.** Push notifications and the proxy transport both need a service the daemon
  can reach. Is that part of fabplane.com (`api.fabplane.com`), or a separate small service?
  Decides N2's interface and T5's auth.
- **Supervised mode semantics.** Which tools pause (all? writes only? exports?) and whether the
  choice is per agent, per project or per thread. Decides A1's shape and the desktop UI.
- **Signing team.** Personal Team (7-day) vs the company team for TestFlight. Decides R1.
- **Tailscale as a requirement vs an option.** If we assume it, T4 can drop plain-HTTP support on
  iOS entirely; if not, LAN HTTP stays and ATS stays open.
