# Sentry error reporting

fabPlane reports crashes and unhandled errors to Sentry from three runtimes: the Electron main
process, the renderer, and the `fabdesk-core` daemon. Every integration is disabled when no DSN is
configured, so development builds, CI and a clone without secrets send nothing. Users can opt out
in **Settings → Privacy** (the `errorReporting` setting, default on).

The setup mirrors fabplane.com (`docs/sentry.md` there): `sendDefaultPii: false`, tracing off
(`tracesSampleRate: 0`), `environment` and `release` on every event, plus `service` and `process`
tags that say which runtime produced it. Request bodies, cookies, authorization headers, bearer
tokens, prompts, `circuit.tsx` contents, `fabdesk.json` and project paths beyond the project id are
never attached.

Sentry project: org `tensorfleet-6g`, project `fabplane-desktop` (Electron). All three runtimes
report to it; filter by `process` / `service`.

## Runtimes, variables and tags

| Runtime        | SDK                                           | DSN                                                                            | Environment                                                                                                             | Release                                                                                              | Tags                                              |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Electron main  | `@sentry/electron/main`                       | `SENTRY_DESKTOP_DSN` (runtime), else `VITE_SENTRY_DESKTOP_DSN` (build time)    | `SENTRY_ENVIRONMENT` (runtime), else `VITE_SENTRY_ENVIRONMENT` (build), else `production` when packaged / `development` | `SENTRY_RELEASE` (runtime), else `VITE_SENTRY_RELEASE` (build), else `fabdesk@<version>+<git-sha>`   | `service=desktop-main`, `process=main`, `channel` |
| Renderer       | `@sentry/electron/renderer` + `@sentry/react` | none: events relay through main                                                | inherited from main (the same `VITE_SENTRY_*` values, inlined into the main bundle)                                     | inherited from main                                                                                  | `service=desktop-renderer`, `process=renderer`    |
| `fabdesk-core` | `@sentry/bun`                                 | `SENTRY_DESKTOP_DSN` (runtime), else the DSN compiled in by `scripts/build.ts` | `SENTRY_ENVIRONMENT` (runtime), else the compiled-in value, else `production` in a compiled binary / `development`      | `SENTRY_RELEASE` (runtime), else `fabdesk-core@<version>+<git-sha>` compiled in (`+dev` from source) | `service=core`, `process=core`, `channel`         |

The legacy spellings `FABDESK_SENTRY_DSN`, `FABDESK_SENTRY_ENVIRONMENT`, `FABDESK_SENTRY_RELEASE`
and `VITE_FABDESK_SENTRY_DSN` keep working as fallbacks. `SENTRY_DSN` is deliberately not read: it is
fabplane's server DSN.

One setting configures both processes: when the desktop's client is active it passes
`SENTRY_DESKTOP_DSN` and `SENTRY_ENVIRONMENT` to the core it spawns
(`apps/desktop/src/main/core-supervisor.ts`, `extraEnv`). A core started on its own (MCP stdio,
`fabdesk-core serve`) falls back to the DSN compiled into the binary, or reports nothing.

An explicitly empty `SENTRY_DESKTOP_DSN=` disables a compiled-in DSN at runtime.

### Release naming

The git sha is resolved at build time: `GITHUB_SHA` in CI, `git rev-parse --short HEAD` locally,
`dev` when neither is available.

- Desktop (main and renderer share one string): `fabdesk@<version>+<sha>`, computed in
  `apps/desktop/electron.vite.config.ts` and inlined as `__FABDESK_SENTRY_RELEASE__`.
- Core: `fabdesk-core@<version>+<sha>`, passed by `apps/core/scripts/build.ts` as the
  `FABDESK_SENTRY_RELEASE` define; running from source yields `fabdesk-core@<version>+dev`.

Both versions are stamped by `scripts/set-version.ts` in the release workflow, so a release's
events match the installer version (`0.<minor>.<run_number>`, see docs/releases.md).

### User

After sign-in every runtime attaches a Sentry user of `{ id: principal.subject, username:
principal.handle }`, never the email or display name, and clears it on sign-out. Local mode uses
`{ id: "local:dev", username: "local" }`. The core follows its own `auth.state` events; the
renderer derives it from the auth store and forwards it to main over IPC
(`apps/desktop/src/shared/sentry-user.ts`, `apps/core/src/sentry.ts` `sentryUserFromAuth`).

### Where the code lives

- `apps/desktop/src/main/sentry.ts`: init before `app.whenReady()` (the SDK registers its IPC
  protocol scheme at init), opt-out handling, user, `coreSentryEnv()`, flush on quit.
- `apps/desktop/src/renderer/sentry.ts`: renderer init (imported first in `main.tsx`) and the
  `Sentry.ErrorBoundary` around the app root.
- `apps/desktop/src/preload/index.ts`: imports `@sentry/electron/preload`, which exposes the IPC
  the renderer uses to hand events to main; it also reads the `--fabdesk-error-reporting` argument
  main sets on the window so the renderer knows whether to start a client at all.
- `apps/desktop/src/shared/sentry-scrub.ts`: `beforeSend` / `beforeBreadcrumb` scrubbing shared by
  main and renderer (unit-tested with `bun test`).
- `apps/core/src/sentry.ts`: core init, opt-out, scrubbing, user and `captureCoreException`.

### Content Security Policy

The renderer never contacts the Sentry ingest host. `@sentry/electron` relays renderer events to
the main process over the preload IPC (or its `sentry-ipc:` custom protocol as a fallback), and the
main process uploads them with Electron's `net` module, which the CSP does not govern. The strict
CSP in `apps/desktop/electron.vite.config.ts` therefore only adds `sentry-ipc:` to `connect-src`;
no `*.ingest.sentry.io` (or self-hosted ingest host) entry is needed, even for a self-hosted Sentry.

## Build-time injection (CI)

Release builds get the DSN from the `SENTRY_DESKTOP_DSN` repository secret. The
"Error reporting environment" step in `.github/workflows/release.yml` exports it, only when set,
as `SENTRY_DESKTOP_DSN` / `VITE_SENTRY_DESKTOP_DSN` (and the legacy `FABDESK_SENTRY_DSN` /
`VITE_FABDESK_SENTRY_DSN`) plus `SENTRY_ENVIRONMENT=production` before the build steps:

- `bun run --cwd apps/core build` passes `--define FABDESK_SENTRY_DSN=...`,
  `FABDESK_SENTRY_ENVIRONMENT=...`, `FABDESK_SENTRY_RELEASE=fabdesk-core@<version>+<sha>` and
  `FABDESK_COMPILED=true` to `bun build --compile`, so the sidecar reports even when started outside
  the desktop app.
- `bun run --cwd apps/desktop build` inlines `import.meta.env.VITE_SENTRY_DESKTOP_DSN`,
  `VITE_SENTRY_ENVIRONMENT` and the release string into the Electron main bundle.

Builds without the secret print `SENTRY_DESKTOP_DSN: unset (error reporting off)` and ship with
reporting disabled. A DSN is a public, write-only ingestion key; never put a Sentry organization
auth token in a `VITE_*` value or in the build environment. Source-map upload is not configured
(it needs a secret auth token during the build; add it through CI if wanted).

Local build with a DSN (staging):

```bash
export SENTRY_DESKTOP_DSN=https://PUBLIC_KEY@SENTRY_HOST/PROJECT
export VITE_SENTRY_DESKTOP_DSN=$SENTRY_DESKTOP_DSN
export SENTRY_ENVIRONMENT=staging VITE_SENTRY_ENVIRONMENT=staging
bun run --cwd apps/core build --only bun-darwin-arm64 --channel public
bun run --cwd apps/desktop build
```

For a dev run without rebuilding, export `SENTRY_DESKTOP_DSN` (and optionally
`SENTRY_ENVIRONMENT=staging`) before `bun run dev`; the desktop forwards both to the core.

## Test events (`FABDESK_SENTRY_TEST=1`)

With `FABDESK_SENTRY_TEST=1` each runtime captures one handled exception at startup
(`fabdesk sentry test main|renderer|core`), flushes, and prints the event id to stderr as
`[sentry] test event process=<p> id=<event id> ...` (the renderer's line is forwarded by main).
Run it against a scratch user-data dir so the dev instance is left alone:

```bash
SENTRY_DESKTOP_DSN=... SENTRY_ENVIRONMENT=staging FABDESK_SENTRY_TEST=1 FABDESK_SMOKE_MS=15000 \
FABDESK_CORE_BIN=apps/core/dist/darwin-arm64/fabdesk-core \
bunx electron apps/desktop --user-data-dir=/tmp/fabdesk-sentry-test
```

Confirm the three ids under the Sentry project, then unset the variable; it is a plain opt-in and
ships in the binaries (it does nothing without a DSN).

## Captured failures

- Desktop main: uncaught exceptions and unhandled rejections in the main process; renderer
  uncaught errors, unhandled rejections and React render failures (via the error boundary), tagged
  `process=renderer`. Native crash minidumps are deliberately disabled (`ElectronMinidump`
  integration filtered out) because raw process memory may contain prompts or tokens; screenshots
  are off.
- Core: unhandled route exceptions in the Hono `onError` (tags `http.method`, `http.route` with the
  route pattern, not the concrete path), job runner failures (tags `job.kind`, `job.class`; expected
  `ToolError`s such as bad arguments or a missing `kicad-cli` are skipped), agent-run failures while
  starting or streaming an adapter (tags `agent`, `agent.phase`), and router worker `error`
  messages (tags `component=router-worker`, `router`).

Scrubbing (`beforeSend` / `beforeBreadcrumb`) drops breadcrumbs for the token-bearing stream URLs
(`/events?token=`, `/ws?token=`), replaces `token`/`access_token`/`refresh_token`/`authorization`
query values and `Bearer` tokens with `[Filtered]` in URLs, messages and exception values, removes
request bodies, cookies and `Authorization`/`Cookie` headers from captured requests, drops `extra`
keys that look like prompts, file contents, paths or credentials, and reduces absolute paths to
`fabdesk.json` / `circuit.tsx` / `circuit.json` to `[project]/<file>` (the core's
`/projects/<id>/files/...` API URLs, which carry only the project id, stay intact).

## Opt-out

`Settings → Privacy → Error reporting` writes `errorReporting` through `PATCH /settings`
(`packages/protocol` `Settings` schema, default `true`). The core closes its client immediately when
the value turns false; the desktop main process does the same, caches the value in
`desktop-prefs.json` so the next launch never initializes the SDK, and the renderer stops its
client. Turning reporting back on takes effect at the next launch.
