# Sentry error reporting

Fabdesk reports crashes and unhandled errors to Sentry from three runtimes: the Electron main
process, the renderer, and the `fabdesk-core` daemon. Every integration is disabled when no DSN is
configured, so development builds, CI and a clone without secrets send nothing. Users can opt out
in **Settings → Privacy** (the `errorReporting` setting, default on).

The setup mirrors fabplane.com (`docs/sentry.md` there): `sendDefaultPii: false`, tracing off
(`tracesSampleRate: 0`), `environment` and `release` on every event, and a `service` tag that says
which runtime produced it. Request bodies, cookies, authorization headers, bearer tokens, prompts,
board files and project paths are never attached.

## Runtimes, variables and tags

| Runtime        | SDK                                           | DSN                                                                            | Environment                                                                          | Release                       | `service` tag                |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------- |
| Electron main  | `@sentry/electron/main`                       | `FABDESK_SENTRY_DSN` (runtime) or `VITE_FABDESK_SENTRY_DSN` (build time)       | `FABDESK_SENTRY_ENVIRONMENT`, else `production` when packaged / `development`        | `fabdesk@<app version>`       | `desktop-main` (+ `channel`) |
| Renderer       | `@sentry/electron/renderer` + `@sentry/react` | none: events relay through main                                                | inherited from main                                                                  | inherited from main           | `desktop-renderer`           |
| `fabdesk-core` | `@sentry/bun`                                 | `FABDESK_SENTRY_DSN` (runtime) or the `FABDESK_SENTRY_DSN` compile-time define | `FABDESK_SENTRY_ENVIRONMENT`, else `production` in a compiled binary / `development` | `fabdesk-core@<core version>` | `core` (+ `channel`)         |

One setting configures both processes: when the desktop's client is active it passes
`FABDESK_SENTRY_DSN` and `FABDESK_SENTRY_ENVIRONMENT` to the core it spawns
(`apps/desktop/src/main/core-supervisor.ts`, `extraEnv`). A core started on its own (MCP stdio,
`fabdesk-core serve`) falls back to the DSN compiled into the binary, or reports nothing.

An explicitly empty `FABDESK_SENTRY_DSN=` disables a compiled-in DSN at runtime.

Use one Sentry project for all three runtimes (events carry `service`), or split desktop and core if
you want separate alert rules. Use `staging`/`production` environment names to keep events apart.

### Where the code lives

- `apps/desktop/src/main/sentry.ts`: init before `app.whenReady()` (the SDK registers its IPC
  protocol scheme at init), opt-out handling, `coreSentryEnv()`.
- `apps/desktop/src/renderer/sentry.ts`: renderer init (imported first in `main.tsx`) and the
  `Sentry.ErrorBoundary` around the app root.
- `apps/desktop/src/preload/index.ts`: imports `@sentry/electron/preload`, which exposes the IPC
  the renderer uses to hand events to main; it also reads the `--fabdesk-error-reporting` argument
  main sets on the window so the renderer knows whether to start a client at all.
- `apps/desktop/src/shared/sentry-scrub.ts`: `beforeSend` / `beforeBreadcrumb` scrubbing shared by
  main and renderer (unit-tested with `bun test`).
- `apps/core/src/sentry.ts`: core init, opt-out, scrubbing and `captureCoreException`.

### Content Security Policy

The renderer never contacts the Sentry ingest host. `@sentry/electron` relays renderer events to
the main process over the preload IPC (or its `sentry-ipc:` custom protocol as a fallback), and the
main process uploads them with Electron's `net` module, which the CSP does not govern. The strict
CSP in `apps/desktop/electron.vite.config.ts` therefore only adds `sentry-ipc:` to `connect-src`;
no `*.ingest.sentry.io` (or self-hosted ingest host) entry is needed, even for a self-hosted Sentry.

## Build-time injection (CI)

Release builds get the DSN from the `FABDESK_SENTRY_DSN` repository secret. The
"Error reporting environment" step in `.github/workflows/release.yml` exports it, only when set,
as both `FABDESK_SENTRY_DSN` and `VITE_FABDESK_SENTRY_DSN` before the build steps:

- `bun run --cwd apps/core build` passes `--define FABDESK_SENTRY_DSN=...` to `bun build --compile`
  (plus `FABDESK_COMPILED=true`, which selects the `production` default environment), so the
  sidecar reports even when started outside the desktop app.
- `bun run --cwd apps/desktop build` inlines `import.meta.env.VITE_FABDESK_SENTRY_DSN` into the
  Electron main bundle.

Builds without the secret print `FABDESK_SENTRY_DSN: unset (error reporting off)` and ship with
reporting disabled. A DSN is a public, write-only ingestion key; never put a Sentry organization
auth token in a `VITE_*` value or in the build environment. Source-map upload is not configured
(it needs a secret auth token during the build; add it through CI if wanted).

Local test build with a DSN:

```bash
FABDESK_SENTRY_DSN=https://PUBLIC_KEY@SENTRY_HOST/PROJECT \
VITE_FABDESK_SENTRY_DSN=https://PUBLIC_KEY@SENTRY_HOST/PROJECT \
bun run package
```

Or, for a dev run without rebuilding, export `FABDESK_SENTRY_DSN` (and optionally
`FABDESK_SENTRY_ENVIRONMENT=staging`) before `bun run dev`; the desktop forwards both to the core.

## Release naming

- Desktop (main and renderer): `fabdesk@<version>` from `app.getVersion()`.
- Core: `fabdesk-core@<version>` from `apps/core/package.json`.

Both versions are stamped by `scripts/set-version.ts` in the release workflow, so a release's
events match the installer version (`0.<minor>.<run_number>`, see docs/releases.md).

## Captured failures

- Desktop main: uncaught exceptions and unhandled rejections in the main process; renderer
  uncaught errors, unhandled rejections and React render failures (via the error boundary), tagged
  `service=desktop-renderer`. Native crash minidumps are deliberately disabled (`ElectronMinidump`
  integration filtered out) because raw process memory may contain prompts or tokens; screenshots
  are off.
- Core: unhandled route exceptions in the Hono `onError` (tags `http.method`, `http.route` with the
  route pattern, not the concrete path), job runner failures (tags `job.kind`, `job.class`; expected
  `ToolError`s such as bad arguments or a missing `kicad-cli` are skipped), agent-run failures while
  starting or streaming an adapter (tags `agent`, `agent.phase`), and router worker `error`
  messages (tags `component=router-worker`, `router`).

Scrubbing (`beforeSend` / `beforeBreadcrumb`) drops breadcrumbs for the token-bearing stream URLs
(`/events?token=`, `/ws?token=`), replaces `token`/`access_token`/`refresh_token`/`authorization`
query values and `Bearer` tokens with `[Filtered]` in URLs, messages and exception values, and
removes request bodies, cookies and `Authorization`/`Cookie` headers from captured requests.

## Opt-out

`Settings → Privacy → Error reporting` writes `errorReporting` through `PATCH /settings`
(`packages/protocol` `Settings` schema, default `true`). The core closes its client immediately when
the value turns false; the desktop main process does the same, caches the value in
`desktop-prefs.json` so the next launch never initializes the SDK, and the renderer stops its
client. Turning reporting back on takes effect at the next launch.

After configuring a DSN, trigger a controlled test event in each runtime, confirm it appears in the
expected project/environment with the right `service` and `release` tags, and remove the test path
before releasing.
