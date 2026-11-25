# First-party product analytics

Fabdesk sends a small set of anonymous product events from the core daemon to fabplane.com. There
is **no PostHog SDK** in the desktop, renderer, or core: the daemon POSTs hashed identifiers
itself. PostHog, when used at all, is a server-side forward on the API.

The onboarding drop-off funnel is a separate lightweight HTTP `/capture/` from `fabdesk-core`
(also no SDK). It is documented in [onboarding-funnel.md](onboarding-funnel.md) and is off unless
`POSTHOG_KEY` is set. That path is not gated by usage-archive consent.

This is not the consented usage archive of conversations and run dumps. That path is documented
in [usage-data-backup.md](usage-data-backup.md). Product analytics never includes design files.

## Opt-out and kill switch

Product events use the **same opt-out as usage-data backup**: Settings → Privacy (**Share usage
data**), including the first-install **Help improve Fabdesk** screen. Revoking consent drops any
queued product events. Data the API already accepted is not erased.

Operators can disable product analytics for a process without touching usage-archive backup:

```bash
export FABDESK_TELEMETRY_ENABLED=false
```

`0`, `off`, and `no` are also off. Any other value turns product analytics on (still subject to
the privacy opt-out above).

## Builds that report

Only a compiled release build reports product events. A daemon run from a checkout (tests,
`bun run dev`) or a build launched with `FABDESK_BUILD_LABEL` sends nothing: each test's fresh
temp home would otherwise count as a new install. With `FABDESK_TELEMETRY_ENABLED` unset,
analytics is also off when `CI` is set, so CI smoke runs of a built binary do not report.
`bun run test` sets `FABDESK_TELEMETRY_ENABLED=false` for every suite as a second guard.

## Ingest

`POST {FABPLANE_API_ORIGIN}/v1/telemetry/events`

The daemon batches up to 50 events and posts JSON `{ "events": [...] }`. Default API origin is
`https://api.fabplane.com`. A failed send never surfaces to the user: the batch is kept and
retried on a timer (30 seconds, doubling to at most 30 minutes), and the first failure of a
streak is logged as a warning in `core.log`. A batch the API rejects as malformed (a 4xx other
than 408 or 429) is dropped with a warning instead of resent. Shutdown flushes the queue without
blocking startup.

## Events

| Name | When |
| --- | --- |
| `app_open` | Core start, every launch |
| `app.active` | Core start, at most once per 24 hours counted from the last heartbeat the API accepted (DAU/WAU/MAU heartbeat) |
| `project_created` | A project is created (`draft: true` for an idea draft) |
| `ai_run` | An in-app agent run starts (`agentId`, e.g. `claude`) |
| `export` | An agent tool named `export_*` is used (`exportTool`, e.g. `export_gerbers`) |

## Fields sent

Each event includes:

- `uuid` — random event id (not the install UUID)
- `event` — one of the names above
- `timestamp` — ISO-8601
- `installId` — SHA-256 hex of a local install UUID
- `accountId` — SHA-256 hex of the fabplane account subject, **only** when auth mode is
  `fabplane` and status is `signed_in`
- `properties.appVersion`, `properties.os` (`darwin` / `linux` / `win32` / `other`),
  `properties.arch`, `properties.authMode`
- optional `properties.draft`, `properties.agentId`, `properties.exportTool`

The raw install UUID is stored only in local settings (`product_analytics_install_id`) and is
hashed before it leaves the machine.

## Never sent

Design files, prompts, file contents, tokens, emails, project names, paths, raw install UUIDs,
and raw account subjects. Extra properties are dropped on the client and rejected by the API.
