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

fabplane-cli's npm publish workflow guards `NPM_TOKEN` the same way (that secret is set); see the
Publishing section of its README.

## Handoff: make the weekly sync open PRs (open as of 2026-09-29)

Neither sync job can open a pull request yet. This section is written so another agent (or a
person) can finish it without earlier context.

### Current state

| Job | Repo / file | Auth it uses | Status |
| --- | --- | --- | --- |
| MCP tool manifest → fabplane-cli | TensorFleet/fabdesk `.github/workflows/fabplane-cli-sync.yml` | `secrets.FABPLANE_CLI_SYNC_TOKEN` (checkout + `peter-evans/create-pull-request@v7`) | Secret missing; the first step fails with `::error title=FABPLANE_CLI_SYNC_TOKEN missing::` |
| OpenAPI spec → fabplane-cli | fabPlane/fabplane-cli `.github/workflows/sync-api.yml` | `GITHUB_TOKEN` (`peter-evans/create-pull-request@v7`) | Fails at "create PR": the org forbids Actions from creating PRs |

Facts already established (no need to re-check):

- The **fabPlane org** policy "Allow GitHub Actions to create and approve pull requests" is **off**.
  `PUT repos/fabPlane/fabplane-cli/actions/permissions/workflow` with
  `can_approve_pull_request_reviews=true` returns `409 The organization does not allow GitHub
  Actions to create or approve pull requests`. Only an org admin can change it
  (`admin:org` scope); the repo-level switch is locked by the org.
- A fine-grained PAT is not subject to that policy, so a PAT fixes **both** jobs.
- `fabPlane/fabplane-cli` is public; `TensorFleet/fabdesk` is private. The fabdesk job needs
  cross-repo write, which `GITHUB_TOKEN` can never give.
- An AI agent running in auto mode was blocked (classifier: "Permission Grant") from creating
  credentials or changing repo/org Actions permissions. **Step 1 must be done by a human.** Do not
  try to work around it with deploy keys, a personal `gh` token copied into a secret, or similar.

### Step 1 — human: create and store the token

1. Create a fine-grained token at <https://github.com/settings/personal-access-tokens/new>:
   - Resource owner **fabPlane**, repository access **Only select repositories → fabplane-cli**.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**
     (Metadata: read is added automatically).
   - Any expiry; when it lapses both jobs fail with the "please add it" error below.
2. Store it on both repos (each command prompts for the value; nothing lands in shell history):
   ```bash
   gh secret set FABPLANE_CLI_SYNC_TOKEN --repo TensorFleet/fabdesk
   gh secret set FABPLANE_CLI_SYNC_TOKEN --repo fabPlane/fabplane-cli
   ```

Optional, not required after step 1: an org admin can turn on **fabPlane → Settings → Actions →
General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**.

### Step 2 — agent: point `sync-api.yml` at the token

In a clone of `fabPlane/fabplane-cli` (branch off `main`, open a PR; the repo is public, so never
commit secrets, internal hostnames or staging credentials):

1. Add a first step to the job, matching the fabdesk workflow and `publish.yml`:
   ```yaml
   - name: Require FABPLANE_CLI_SYNC_TOKEN
     env:
       FABPLANE_CLI_SYNC_TOKEN: ${{ secrets.FABPLANE_CLI_SYNC_TOKEN }}
     run: |
       if [ -z "$FABPLANE_CLI_SYNC_TOKEN" ]; then
         echo "::error title=FABPLANE_CLI_SYNC_TOKEN missing::Please add the FABPLANE_CLI_SYNC_TOKEN repository secret (fine-grained PAT: contents + pull-requests write on fabPlane/fabplane-cli). The fabPlane org does not let GITHUB_TOKEN open pull requests. See the README's 'Weekly sync' section."
         exit 1
       fi
   ```
2. In the `peter-evans/create-pull-request` step, replace `token: ${{ secrets.GITHUB_TOKEN }}`
   (or the implicit default) with `token: ${{ secrets.FABPLANE_CLI_SYNC_TOKEN }}`. PRs opened with
   a PAT also trigger `ci.yml`, so the workaround that ran the tests inside the sync job can stay or go.
3. Document the secret in the README's weekly-sync section, next to the `NPM_TOKEN` note.
4. Merge that PR (ask the user first if you lack merge permission).

Nothing changes in fabdesk: `fabplane-cli-sync.yml` already uses `FABPLANE_CLI_SYNC_TOKEN` and
guards for it.

### Step 3 — agent: verify

```bash
gh secret list --repo TensorFleet/fabdesk | grep FABPLANE_CLI_SYNC_TOKEN
gh secret list --repo fabPlane/fabplane-cli | grep FABPLANE_CLI_SYNC_TOKEN
gh workflow run fabplane-cli-sync.yml --repo TensorFleet/fabdesk --ref main
gh workflow run sync-api.yml --repo fabPlane/fabplane-cli --ref main
gh run list --repo TensorFleet/fabdesk --workflow fabplane-cli-sync.yml --limit 1
gh run list --repo fabPlane/fabplane-cli --workflow sync-api.yml --limit 1
gh pr list --repo fabPlane/fabplane-cli --head sync/fabdesk-tools
```

Expected:

- **fabdesk job:** opens (or updates) a PR from `sync/fabdesk-tools` on fabplane-cli. The branch
  adds the `shopping_list_*` / `inventory_*` tools, which the committed snapshot lacks, so the first
  run should produce a PR.
- **`sync-api`:** exits cleanly with "no changes" when production doesn't serve
  `/v1/public/openapi.json` yet (it 404s until the orgs/carts/inventory backend reaches
  production). It opens a PR only when the live spec differs from `spec/openapi.json`.

`fabplane-cli-sync.yml` only exists on fabdesk `main` once the `feat/shopping-list-inventory`
branch is merged; before that, dispatch with `--ref feat/shopping-list-inventory`.

Done when both runs are green and the tool-manifest PR exists. Then delete this handoff section,
keeping a one-line note that both jobs use `FABPLANE_CLI_SYNC_TOKEN`.
