# fabplane-cli in fabdesk

[`fabplane-cli`](https://github.com/fabPlane/fabplane-cli) (public, MIT) is the typed client, CLI and
MCP server for the fabplane.com API: orgs, invites, API tokens, shopping carts and team inventory,
plus a client for this desktop daemon. fabdesk consumes it as the `vendor/fabplane-cli` submodule,
a root workspace; Bun resolves its TypeScript source through the package's `bun` export condition,
and `apps/core/tsconfig.typecheck.json` maps it to `src/index.ts` for `tsc`.

- The daemon builds `FabplaneClient` in `apps/core/src/cloud.ts`; `CloudService`
  (`packages/tools/src/cloud/service.ts`) backs the `/cloud/*` and `/projects/:id/shopping-list*`
  routes and the `shopping` toolset.
- Bump it like the other submodules: `bun run submodules:update`. Change it with a PR to
  fabPlane/fabplane-cli, never in `vendor/`.

## Weekly sync

- **API calls** — fabplane-cli's `sync-api.yml` (Mondays 03:00 UTC) pulls
  `https://api.fabplane.com/v1/public/openapi.json` and opens a PR there when operations change.
- **MCP tools** — this repo's `.github/workflows/fabplane-cli-sync.yml` (Mondays 04:00 UTC) runs
  `bun scripts/export-tool-manifest.ts` and opens a PR on fabplane-cli updating
  `spec/fabdesk-tools.json`.

### TODO: add the `FABPLANE_CLI_SYNC_TOKEN` secret

The tool sync needs a fine-grained GitHub token with **contents: write** and **pull-requests: write**
on `fabPlane/fabplane-cli`, stored as the `FABPLANE_CLI_SYNC_TOKEN` Actions secret on this repo.
Until it is added the workflow fails its first step with "Please add the FABPLANE_CLI_SYNC_TOKEN
repository secret".

fabplane-cli's own npm publish workflow has the same guard for `NPM_TOKEN`; see the Publishing
section of its README.
