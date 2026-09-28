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

fabplane-cli's npm publish workflow separately uses `NPM_TOKEN`; see the Publishing section of its
README.

## GitHub App setup for weekly sync

Both jobs use a short-lived GitHub App installation token to write to
`fabPlane/fabplane-cli`. No personal access token or deploy key is needed. The App is installed
only on `fabPlane/fabplane-cli`; fabdesk creates a token for that installation. The built-in
`GITHUB_TOKEN` cannot write to another repository, and the fabPlane organization currently blocks
Actions from opening pull requests with that token.

An owner of the fabPlane organization must complete the credential steps:

1. Create a private GitHub App owned by fabPlane, with its webhook disabled. Grant repository
   permissions **Contents: Read and write** and **Pull requests: Read and write** (Metadata read
   is automatic). Install it with **Only select repositories → fabplane-cli**.
2. Generate a private key from the App settings. Keep it out of git and chat.
3. In both `fabPlane/fabplane-cli` and `TensorFleet/fabdesk`, set the Actions variable
   `FABPLANE_CLI_SYNC_APP_ID` to the App ID and the Actions secret
   `FABPLANE_CLI_SYNC_APP_PRIVATE_KEY` to the complete private-key PEM. The same App ID and key
   are used in both repositories. The private key is held as a secret; the App ID is not secret.
4. Remove any obsolete `FABPLANE_CLI_SYNC_TOKEN` secret after the App-backed runs succeed.

Each workflow checks these settings before doing work. It then uses
`actions/create-github-app-token@v2` with `owner: fabPlane` and
`repositories: fabplane-cli`, requesting only Contents and Pull requests write. The token
expires after one hour and the action revokes it at job end. fabdesk passes it to the target
repository checkout and PR step; fabplane-cli passes it to its PR step.

### Verify

Run `sync-api.yml` on fabplane-cli `main`, then
`fabplane-cli-sync.yml` on fabdesk `feat/shopping-list-inventory` until that branch is merged.
Both runs should be green. The fabdesk run should open or update the
`sync/fabdesk-tools` pull request in fabplane-cli. The API sync should report no changes while
production does not serve `/v1/public/openapi.json`; it opens a PR only when the live spec changes.
After the fabdesk feature branch is merged, verify its job again on `main`.
