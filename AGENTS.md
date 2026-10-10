# fabPlane — agent notes

- Bun 1.4.x monorepo. Run everything from the repo root: `bun install`, `bun run typecheck`, `bun run test` (not bare `bun test`, which recurses into `vendor/`).
- Build on a branch and open a PR **against `main`**; do not commit directly to `main`. The only exception is a small fix that cleans up a mistake already on `main`.
- Do not use a `dev` (or any other long-lived integration) branch, in this repo or in `vendor/fab_pcb`: target `main` and stack short-lived feature branches instead. The old `dev` branches were folded into `main` on 2026-10-02. `vendor/fab_pcb` must always pin a commit on fab_pcb's `main`.
- Never run `bun install` inside `vendor/fabplane` or `vendor/fab_pcb`. `vendor/fab_pcb/packages/{proto,client,kicad-wasm}` are root workspaces (the client's tests import kicad-wasm); `bun run fp-pcb:types` (part of `typecheck`) emits their declarations; `apps/core/tsconfig.typecheck.json` maps the imports to them for `tsc` only (Bun honours tsconfig `paths` at runtime, so the mapping must stay out of the config chain Bun reads).
- `vendor/*` are git submodules. Do not edit them here; change fabplane via a PR to `TensorFleet/fabplane.com` and FabPlane PCB via a PR to `fabPlane/fab_pcb`, then bump with `bun run submodules:update`.
- `vendor/fabplane-cli` (public, fabPlane/fabplane-cli) is the fabplane.com API client/CLI/MCP package; the daemon's carts + inventory go through it (`docs/fabplane-cli.md`). Add new fabplane.com calls there, not ad hoc in fabdesk.
- FreeCAD (the `cad` toolset, the desktop's CAD tab) goes through the FabPlane CAD bridge from `vendor/fab_cad` (fabPlane/fab_cad, over the fabPlane/FreeCAD fork's API); see `docs/fab-cad.md`. `vendor/fab_cad/packages/{protocol,client,mock-server,bridge}` are root workspaces; `bun run fab-cad:types` (part of `typecheck`) emits the client's declarations for `tsc`, like `fp-pcb:types`. Never `bun install` inside `vendor/fab_cad`.
- Import fabplane's KiCad CLI helpers via the `@pcb/pcb/kicad-cli` subpath only. The package root pulls in sharp and the AWS SDK.
- fabPlane code imports `zod/v4` (root pins zod 3.25.x).
- MCP tool names use underscores (`circuit_build`), never dots.
- MCP Apps views and OpenAI MCP Extensions (`board_viewer`, `shopping_list_viewer`, `ui://fabdesk/*`) live in `packages/tools/src/adapters/mcp-apps.ts` and `packages/tools/src/apps/`; the Codex / Claude Code plugin is `plugins/fabplane/`. Views reach the server only through `fabdesk_ui_call` and its `UI_CALLABLE_TOOLS` allowlist. See `docs/mcp-extensions.md`.
- Routing, compiling and library search run on the FabPlane PCB bridge (`docs/fab-pcb-migration.md`); fabdesk's own packages carry no tscircuit-ecosystem dependency and no `circuit.json`. New projects default to Freerouting with automatic fab_router fallback; either router can be selected explicitly. Optional routers (TraceMaker, and Freerouting when it is not bundled) install on demand into the per-user fabdesk data dir — see `docs/routers.md`. TraceMaker Install prefers a weekly TensorFleet-built binary from the `tracemaker-latest` GitHub release (GPL-3.0-or-later; LICENSE + SOURCE.txt; macOS uses Homebrew LLVM static libc++ and minos 15, plus a commit-pinned from_chars + `<cstdlib>` patch on v0.9.0 that must not call `strtod_l`; LLVM flags also force-include C stdlib headers; SQLite headers are isolated so FindSQLite3 does not `-isystem` the Xcode SDK ahead of libc++, and the binary links `/usr/lib/libsqlite3.dylib` not Homebrew sqlite). The default GitHub URL 404s while this repo is private — override with `FABDESK_TRACEMAKER_MANIFEST_URL` or Settings `tracemakerManifestUrl`; do not ship a token. Falls back to the upstream source tarball or `TRACEMAKER_BIN`. `route_run` accepts `router=fab_router|freerouting|capacity|tracemaker`; an uninstalled on-demand router fails with an install hint (Settings → Routers, or `TRACEMAKER_BIN` / `FREEROUTING_JAR`).
- Relative imports are extensionless (`./events`, not `./events.ts`); `allowImportingTsExtensions` is off, matching fabplane.
- Client code that is not DOM-bound belongs in `packages/client-core` (transport, event reducer, query hooks, stores), not `packages/ui`. `packages/ui` re-exports it, so the desktop keeps one import site.
- `apps/mobile` (the Expo client for iOS and Android) is **not** a root workspace and has its own `bun.lock`: run `bun run mobile:install` / `mobile:typecheck` / `mobile:test`, never plain `bun install` from inside it. It aliases `@fabdesk/client-core` and `@fabdesk/protocol` to their source in `metro.config.js` and `tsconfig.json`; keep the two in step. Root `typecheck`/`test` deliberately skip it — CI is `.github/workflows/mobile.yml`. See `docs/mobile.md`; release steps in `docs/mobile-release.md`. `apps/relay` (the reference relay a daemon dials out to) **is** a root workspace.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; use the `...(x ? { k: x } : {})` idiom for optional fields.
- Daily jobs: security scan + issue filing is `.github/workflows/security-scan.yml` (`bun run security:scan` / `security:issues`). Open-PR relevance notifies the Grok Cloud Agent (`bun run pr:relevance`). See `docs/daily-jobs.md`.
- Open-source catalog preview/photo images are published by the **fabplane.com** `catalog-sync` GitHub Action (`workflow_dispatch`, or a `main` push that touches catalog seed / preview generator paths only). Fabdesk merges do not upload to R2. Do not add a fabdesk workflow that syncs catalog images on every merge.

## Staging login (Cloud Agents)

Staging is on Tailscale (`tag:cursor-staging`, ports 4000 and 5173 only). Production (`api.fabplane.com`) stays password-off.

- API: `http://fabplane-staging.tail4f6a7.ts.net:4000`
- Device UI: `http://fabplane-staging.tail4f6a7.ts.net:5173/device`
- Accounts: `maya` / `demo`, password `fabplane-dev`

Set the Cursor environment secret `TS_AUTH_KEY`. After `start-tailscale.sh` joins the tailnet:

```bash
export ALL_PROXY=socks5h://127.0.0.1:1055
export HTTP_PROXY=http://127.0.0.1:1054
export HTTPS_PROXY=http://127.0.0.1:1054
FABPLANE_API_ORIGIN=http://fabplane-staging.tail4f6a7.ts.net:4000 \
  bun run --cwd apps/core src/main.ts login --email maya --password fabplane-dev
```

Never send those credentials to `https://api.fabplane.com`.

## Backend deploys

Backend / Hono API / production `api.fabplane.com` changes are **not** auto-deployed on merge to `main`. Merges to `main` only deploy the public Astro site (`deploy-public` → `fabplane.com`). Do not assume `https://api.fabplane.com` has the same code as `fabplane.com` or as `main`.

If a backend change is needed: test on staging first (fabplane **Deploy staging backend** `workflow_dispatch`, or the Tailscale staging API above). After staging is verified, ask the user before deploying production. Production API deploys are manual.

## Source maps

Never package, embed, or ship source maps inside fabPlane, its installers, app
archives, or update artifacts. Production web deployments must not publish or
serve source maps either. Source maps may be generated only transiently for
private error-symbol processing when the release workflow removes them before
the application or deployment artifact is assembled.
