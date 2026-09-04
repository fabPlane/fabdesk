# Fabdesk — agent notes

- Bun 1.4.x monorepo. Run everything from the repo root: `bun install`, `bun run typecheck`, `bun test`.
- Build on a branch and open a PR; do not commit directly to `main`. The only exception is a small fix that cleans up a mistake already on `main`.
- Never run `bun install` inside `vendor/fabplane` or `vendor/js_autorouter`.
- `vendor/*` are git submodules. Do not edit them here; change fabplane via a PR to `TensorFleet/fabplane.com` and bump with `bun run submodules:update`.
- Import fabplane's KiCad CLI helpers via the `@pcb/pcb/kicad-cli` subpath only. The package root pulls in sharp and the AWS SDK.
- Fabdesk code imports `zod/v4` (root pins zod 3.25.x so tscircuit gets v3).
- MCP tool names use underscores (`circuit_build`), never dots.
- `packages/router-freerouting` and `vendor/js_autorouter` are internal-only; anything shipped in a public build must not reference them.
- Relative imports are extensionless (`./events`, not `./events.ts`); `allowImportingTsExtensions` is off, matching fabplane.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; use the `...(x ? { k: x } : {})` idiom for optional fields.
- Daily jobs: security scan + issue filing is `.github/workflows/security-scan.yml` (`bun run security:scan` / `security:issues`). Open-PR relevance notifies the Grok Cloud Agent (`bun run pr:relevance`). See `docs/daily-jobs.md`.

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

Never package, embed, or ship source maps inside Fabdesk, its installers, app
archives, or update artifacts. Production web deployments must not publish or
serve source maps either. Source maps may be generated only transiently for
private error-symbol processing when the release workflow removes them before
the application or deployment artifact is assembled.
