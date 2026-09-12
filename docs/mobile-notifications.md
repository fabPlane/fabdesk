# Push notifications for the mobile app — design

Status: proposed, 2026-09-12. Covers roadmap packages **N1, N2, N3** (`docs/mobile-roadmap.md`)
and the **fabplane.com** half that makes push possible. Written so the three halves — daemon,
phone, fabplane.com — can be built by different people against the contracts in §4 without
talking to each other.

## 1. What it has to do

A run on the user's computer finishes, fails, or (later) needs a decision. The phone — in a
pocket, on cellular, app closed — shows a notification within seconds; tapping it opens that
thread. That is the whole reason to carry the app.

Constraints that shape the design:

- **The daemon is on a machine we cannot reach from the internet.** It has no inbound port
  beyond the tailnet/LAN remote listener. Anything that must arrive on a phone that is _not_ on
  that network has to go through a service the daemon can dial **out** to. fabplane.com is that
  service; the daemon already holds a bearer for it in `fabplane` auth mode.
- **Pairing is the trust root.** A phone that scanned the QR holds a device token for that daemon
  (`devices` table, SHA-256 digest server-side). Push registration must ride on that, not on a
  second login.
- **fabplane.com must not become a control plane.** It forwards notifications; it never sees
  device tokens, thread content, or which daemon is which beyond the user who owns it. It keeps
  nothing that would let it impersonate a device.
- **Local-mode daemons** (no fabplane.com account) must still get the cheap version: local
  notifications while the app is backgrounded but the socket is alive (N1).
- **Do not run an APNs/FCM integration ourselves in v1.** Use Expo's push service
  (`https://exp.host/--/api/v2/push/send`): one HTTP API for both platforms, tokens are opaque
  strings, and the APNs key/FCM credentials live in the EAS project, not on fabplane.com. The cost
  is an EAS project and a dependency on Expo's service; §7 says how to swap it out later.

## 2. Architecture

```
 phone (paired)                daemon (fabdesk-core)              fabplane.com API            Expo push → APNs/FCM
 ───────────────               ─────────────────────              ─────────────────           ────────────────────
 expo-notifications
   ├─ permission               devices table gains
   ├─ ExponentPushToken[…] ──▶ push_token, prefs   (PUT /v1/devices/me/push, device-token auth,
   │                           per device)          remote listener)
   │
   │                           bus: agent.done / agent.error / (later) agent.approval_requested
   │                             │
   │                             ▼
   │                           Notifier
   │                             ├─ device has a live /ws socket?  → skip (app is up; it saw it)
   │                             ├─ prefs say no?                  → skip
   │                             └─ POST /v1/private/push ───────▶ auth: daemon's user bearer
   │                                {messages:[{to, title, body, data}]}    │ rate-limit per user
   │                                                                        │ validate, forward ─▶ Expo ─▶ device
   │                                                                        └─ tickets back
   ◀────────────────────────────────────────────────────────────────────────────────────── notification
   tap → data.{coreId, threadId} → switch connection if needed → /thread/[id]
```

Three independent halves, one contract each:

| Half               | Owner                                 | Contract                                                          |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------- |
| Daemon (N2)        | fabdesk `apps/core`                   | §4.1 device push registration; §4.2 what it sends to fabplane.com |
| fabplane.com       | `TensorFleet/fabplane.com` `apps/api` | §4.2 `POST /v1/private/push`; §5 storage, limits, receipts        |
| Phone (N1, N3, N4) | fabdesk `apps/mobile`                 | §4.1 registration; §4.3 notification payload it must handle       |

Nothing here needs the Phase 4 relay/proxy transport. If that lands later, push can move onto
it; until then this is a one-way, fire-and-forget path and is deliberately simple.

## 3. Flows

### 3.1 Registration

```mermaid
sequenceDiagram
  participant P as Phone
  participant D as Daemon (remote listener)
  P->>P: user enables "Notify me" in Settings → OS permission prompt
  P->>P: Notifications.getExpoPushTokenAsync({ projectId })
  P->>D: PUT /v1/devices/me/push  (Authorization: Bearer <deviceToken>)<br/>{ expoPushToken, platform, prefs }
  D->>D: look up device by token digest; store token + prefs
  D-->>P: 200 { device, push: { registeredAt } }
  Note over P,D: repeated on every connect (token can rotate) and on prefs change
```

The phone registers with **every** daemon it is paired with; each daemon notifies independently.
Turning the toggle off sends `DELETE /v1/devices/me/push` to each and clears local state.

### 3.2 Delivery

```mermaid
sequenceDiagram
  participant A as Agent run
  participant B as Bus
  participant N as Notifier (daemon)
  participant F as fabplane.com
  participant E as Expo push
  participant P as Phone
  A->>B: agent.done { runId, threadId, status }
  B->>N: event
  N->>N: for each device with push_token: skip if live socket, skip if prefs exclude
  N->>F: POST /v1/private/push (Bearer <user session>)<br/>{ messages: [ {to, title, body, data, ...} ] }
  F->>F: auth → user; rate limit; validate tokens; audit row
  F->>E: POST /--/api/v2/push/send (same messages)
  E-->>F: tickets [{status:"ok", id} | {status:"error", details}]
  F-->>N: 200 { tickets }
  E->>P: APNs/FCM
  P->>P: tap → navigate to coreId/threadId
```

If the daemon is in local mode, or has no bearer, or fabplane.com is unreachable: the Notifier
logs once at `info` and drops. There is no queue in v1 — a missed "run finished" is annoying, not
harmful, and the phone sees the state the next time it connects.

### 3.3 Local notifications (N1 — no server involved)

While the app is **backgrounded** but its WebSocket is still alive (iOS gives ~30 s, Android
more), `CoreConnection` sees `agent.done` itself and schedules an immediate local notification with
the same payload shape as §4.3. When the app is foregrounded, nothing is shown (the thread is on
screen or one tap away). When the socket is dead, push (§3.2) is the only path. The phone
de-duplicates by `runId` so a run that arrives both ways shows once.

## 4. Contracts

### 4.1 Daemon: device push registration (remote listener)

Both routes are authenticated by the **device token** (`Authorization: Bearer <deviceToken>`), the
same credential every other remote request uses; the daemon resolves the device from the token
digest. They are served on the remote listener **and** the local one (the simulator pairs over
loopback). They are not device-administration routes, so they are not `localOnly`.

```ts
// packages/protocol/src/devices.ts
export const DevicePushPrefs = z.object({
  onDone: z.boolean().default(true), // agent.done status=completed
  onFailed: z.boolean().default(true), // agent.done status=failed|aborted, agent.error
  onNeedsInput: z.boolean().default(true), // future: agent.approval_requested / question
  onJobs: z.boolean().default(false), // job.done for long jobs (route_run, render)
});
export const DevicePushRegistration = z.object({
  expoPushToken: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/),
  platform: DevicePlatform, // "ios" | "android"
  appVersion: z.string().optional(),
  prefs: DevicePushPrefs.default({}),
});
```

| Route                        | Body                     | Response                                                              |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `PUT /v1/devices/me/push`    | `DevicePushRegistration` | `200 { device: Device, push: { registeredAt } }`                      |
| `DELETE /v1/devices/me/push` | —                        | `200 { ok: true }`                                                    |
| `GET /v1/devices/me`         | —                        | `200 Device` (adds `push: { registeredAt, platform, prefs } \| null`) |

`devices` table gains `push_token TEXT`, `push_platform TEXT`, `push_prefs TEXT` (JSON),
`push_registered_at INTEGER`. Revoking a device (`DELETE /v1/devices/:id`) drops all of it. The
push token is stored in the clear: it is Expo-opaque, useless without our Expo project's
credentials, and the daemon needs it verbatim.

`Settings` gains `notifications: { enabled: boolean /* default true */ }` — a daemon-wide kill
switch shown on the desktop's Remote access section.

### 4.2 fabplane.com: `POST /v1/private/push`

Authenticated exactly like `/v1/private/me`: the daemon's session bearer (obtained via the existing
device-code login). The user id from the session is the tenant for limits and audit.

Request:

```ts
export const PushMessage = z.object({
  to: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/),
  title: z.string().max(80),
  body: z.string().max(200),
  data: z.object({
    v: z.literal(1),
    kind: z.enum(["run.done", "run.failed", "run.needs_input", "job.done"]),
    coreId: z.string(), // daemon identity (see 4.4)
    coreName: z.string(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    jobId: z.string().optional(),
    projectId: z.string().optional(),
  }),
  sound: z.enum(["default"]).optional(),
  badge: z.number().int().optional(),
  channelId: z.string().optional(), // Android channel, "runs" by default
  ttl: z.number().int().min(0).max(86_400).optional(),
  priority: z.enum(["default", "normal", "high"]).optional(),
  categoryId: z.string().optional(), // iOS action category; "run" for now
});
export const PushRequest = z.object({ messages: z.array(PushMessage).min(1).max(20) });
```

Response `200`:

```ts
export const PushTicket = z.union([
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string() }).optional(),
  }),
]);
export const PushResponse = z.object({ tickets: z.array(PushTicket) }); // same order as messages
```

Errors: `401` no/expired session; `400` schema; `429` over limit with `Retry-After`; `502` Expo
unreachable (body `{ error: "upstream" }`); the daemon treats 5xx/429 as "drop this batch".

The route **must not** log `title`/`body`/`data` at info level, must not store them (audit row has
counts only, §5), and must forward the messages to Expo unchanged apart from server-side fields
(`accessToken` header, nothing added to `data`).

### 4.3 Notification payload the phone handles

Whether from push (`data` above) or from a local notification, the phone reads only `data`:

- Validate `v === 1` and a known `kind`; anything else opens the app on Chats.
- If `coreId` matches a saved connection that is not active, switch to it first.
- `threadId` → `router.push("/thread/[id]")`; `jobId` without a thread → `/jobs`.
- Dedupe key: `${coreId}:${runId ?? jobId}`; keep the last 100 in local storage.
- Never trust `title`/`body` for anything beyond display.

Text the daemon uses (keep it content-free; the thread title is the most it reveals):

| kind              | title                        | body                                                      |
| ----------------- | ---------------------------- | --------------------------------------------------------- |
| `run.done`        | `Done · <thread title>`      | `<agent> finished in <project or "a chat"> on <coreName>` |
| `run.failed`      | `Failed · <thread title>`    | `<agent> stopped in <project> — tap to see why`           |
| `run.needs_input` | `Needs you · <thread title>` | `<agent> is waiting for an answer`                        |
| `job.done`        | `<Kind> finished`            | `<project> on <coreName>`                                 |

### 4.4 `coreId`

The daemon needs a stable identity across restarts so a phone paired with two computers can tell
them apart in a notification. Add `core_id` to the daemon's settings store, minted once (`core_` +
12 random chars), returned by `/health` as `coreId` and by `pair/claim` in `result.core`. The
phone stores it on the connection (`Connection.coreId`) and uses it for §4.3. Existing
connections without it fall back to matching by `deviceId`.

## 5. fabplane.com side — for the agent adding it

Where: `vendor/fabplane` → `TensorFleet/fabplane.com`, `apps/api` (Hono 4 on Bun, Postgres via
`@pcb/db`, sessions in `sessions` table by token hash). Follow the existing route/auth style in
`apps/api/src/app.ts` and `auth.ts`.

1. **Route** `POST /v1/private/push` per §4.2, using the same session lookup as
   `GET /v1/private/me`.
2. **Migration** `000N_push.sql`:
   ```sql
   CREATE TABLE push_batches (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(),
     message_count int NOT NULL,
     ok_count int NOT NULL,
     error_count int NOT NULL,
     upstream_ms int
   );
   CREATE INDEX push_batches_user_created ON push_batches (user_id, created_at DESC);
   ```
   Counts only — no tokens, no text. Retention: delete rows older than 30 days (a job, or a
   cron in `infra`).
3. **Rate limit** per user, from `push_batches`: 60 messages / minute and 2 000 / day (env
   `PUSH_PER_MINUTE`, `PUSH_PER_DAY`). Over → `429` + `Retry-After`.
4. **Forward** to `https://exp.host/--/api/v2/push/send` with `Authorization: Bearer
$EXPO_ACCESS_TOKEN` (an Expo access token with push enabled; keeps other people from spamming
   our tokens if one leaks) and `Accept-Encoding: gzip`; 10 s timeout; map Expo's response
   `data[]` 1:1 to `tickets`. Do not retry on the request path; return the error.
5. **Receipts** (v1.1): Expo reports `DeviceNotRegistered` in _receipts_ fetched ≥ 15 min later
   from `/--/api/v2/push/getReceipts`. Store ticket ids with the batch, run a receipt check job,
   and expose `GET /v1/private/push/dead-tokens?since=<iso>` returning tokens that came back
   `DeviceNotRegistered`; daemons poll it on startup and clear those tokens. Not needed for v1 —
   an unregistered token only costs one rejected message per event.
6. **Config**: `EXPO_ACCESS_TOKEN` (required for the route to be enabled; without it the route
   returns `503 { error: "push disabled" }`), `PUSH_PER_MINUTE`, `PUSH_PER_DAY`.
7. **Tests** (`apps/api/src/push.test.ts`, in the style of `app.test.ts`): 401 without session;
   400 on a bad token format; 429 after the limit; forward + tickets with a mocked upstream;
   nothing but counts in `push_batches`.
8. **Deploy**: staging first (Deploy staging backend workflow), verify with a real daemon in
   `fabplane` mode against `FABPLANE_API_ORIGIN=<staging>`, then production is a manual deploy
   (see `AGENTS.md` — merges to `main` do not deploy the API).

## 6. Daemon and phone work (fabdesk side)

**N2 — daemon** (`apps/core`): migration for the `devices` columns; the two routes; `coreId`;
`Settings.notifications.enabled`; a `Notifier` service subscribed to the bus that resolves
recipients (skip devices with a live socket — the WebSocket handler already knows the token per
socket; keep a `Set<deviceId>` of open sockets), builds messages per §4.3, posts through the
`AuthFacade`'s bearer fetch, and logs outcomes. Tests in `apps/core/test/notifications.test.ts`:
registration round-trip over the remote listener, revoke clears it, `agent.done` → one POST with
the expected message (mock fetch), no POST when the device's socket is open, no POST in local
mode, prefs respected.

**N1 — phone, local** (`apps/mobile`): `expo-notifications` permission + channel `runs`;
on `agent.done`/`agent.error` while `AppState !== "active"`, schedule a local notification with
the §4.3 payload; tap handling and dedupe per §4.3. No server.

**N4 — phone, push registration**: Settings toggle "Notify me when runs finish" with the four
prefs; get the Expo token (needs `extra.eas.projectId` in `app.json` — prerequisite from roadmap
R1; until then the toggle explains it is unavailable in dev builds); `PUT /v1/devices/me/push` on
every successful connect and on prefs change, `DELETE` on toggle off; store `coreId` on the
connection.

**N3 — Live Activity** (iOS 16.1+): a run in progress shows elapsed time and the current tool
on the lock screen, with Stop. Needs a small native module (ActivityKit) or a maintained Expo
module; start after N1/N4 are in. Updates come from the WebSocket while alive, or from push
with `apns-push-type: liveactivity` later — not in v1.

_Investigation (2026-09-13, app on Expo SDK 54 / RN 0.81 / New Architecture):_

| Option                                                      | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verdict                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `expo-widgets` (official, `expo/expo`)                      | The supported path: config plugin generates the widget-extension target and App Group; a Live Activity is a React component rendered to SwiftUI via `@expo/ui`; `LiveActivityFactory.start(props, url)`, `instance.update(props)`, `instance.end(policy)`; buttons via App Intents (`onPress` returns new props, runs without the app process); push-to-start and per-activity APNs tokens when `enablePushNotifications` is on. First release `55.0.0-alpha.0` (2026-01); `57.0.19` current (2026-09-11). **No SDK 54 build exists.** | Use it — after the SDK upgrade.              |
| `expo-live-activity` (software-mansion-labs)                | Config plugin + fixed SwiftUI template (title, subtitle, progress bar / elapsed timer, image, colours, `deepLinkUrl`); iOS 16.2+; last release 0.4.2 (2025-11). Repository **archived 2026-06-01** with "consider expo-widgets".                                                                                                                                                                                                                                                                                                       | No — unmaintained.                           |
| `@bacons/apple-targets` 5.0 + our own Swift                 | Maintained (2026-07, `expo >= 52`), generates the extension target from `targets/*/expo-target.config.js`; we would write the ActivityKit attributes, the SwiftUI view, an Expo module for start/update/end, and an App Intent for Stop ourselves — roughly 250–400 lines of Swift plus the plugin config.                                                                                                                                                                                                                             | Fallback only if the SDK upgrade is blocked. |
| `react-native-live-activity` and other one-off npm packages | Abandoned (2023) or single-author templates without New Architecture claims.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No.                                          |

Nothing is a drop-in for SDK 54, so N3 is **not implemented** in this pass. Recommended approach:

1. Bump `apps/mobile` to the current Expo SDK (57 at the time of writing; SDK 54 was also the
   last with legacy-architecture support, so the upgrade is due anyway). Roadmap R1 (EAS
   project, signing) should land first — Live Activities need a real device and the widget
   extension needs its own bundle id / provisioning.
2. Add `expo-widgets`; declare one widget `run` in `app.json` (`bundleIdentifier`
   `com.tensorfleet.fabdesk.mobile.run`, App Group `group.com.tensorfleet.fabdesk`).
3. `src/notifications/live.ts`: on `agent.started` start an activity with
   `{ threadTitle, agent, coreName, startedAt, tool: null }` and `url = fabdesk://thread/<id>`;
   on `agent.tool_use` update `tool`; on `agent.done` / `agent.error` end with `after(+5 min)`.
   Only for the active connection's runs, only while the socket is alive (the same window as
   N1). Roughly 100 lines on our side plus a ~40-line widget component.
4. **Stop**: a button whose `onPress` runs in the widget runtime, without the app, so it cannot
   reach the daemon with the device token. For v1 make Stop a deep link into the thread (which
   has the real Stop); a true remote Stop waits for the Phase 4 relay, when an App Intent can
   POST `/threads/:id/abort` through it with a token read from the App Group.
5. Push-driven updates (`apns-push-type: liveactivity`) need fabplane.com to forward to APNs
   directly (§7) — not through Expo's push API. Out of scope until then; the socket window is
   enough to show "running · 2:14 · route_run" for the runs that matter.

## 7. Trade-offs and later changes

- **Expo push vs direct APNs/FCM.** Direct would remove the Expo dependency and let fabplane.com
  hold the APNs key. The daemon→fabplane.com contract (§4.2) is deliberately Expo-shaped only in
  the token regex; swapping the forwarder for direct APNs/FCM later changes fabplane.com internals
  and the token format, nothing in the daemon's message shape.
- **Why the daemon, not the phone, talks to fabplane.com.** The phone does not need a fabplane.com
  login to use the app, and pairing already proves the phone is the user's. Registering tokens on
  the daemon keeps fabplane.com stateless about devices. The cost: a phone paired with N computers
  registers N times, and each computer needs a fabplane.com session — acceptable; local-mode
  daemons simply do not push.
- **Content in notifications.** The thread title is the only user text sent. If that is too much
  for some users, `prefs.privateTitles` (send "A run finished") is a one-line addition on the
  daemon side.
- **Approvals from the notification** (approve/deny actions without opening the app) need the
  supervised runtime mode (roadmap A1) and a way for the phone to reach the daemon from a
  notification action — which is the Phase 4 relay. Design the iOS category `run` now with no
  actions; add them then.
