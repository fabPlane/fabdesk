# Handoff: finish the fabdesk Cloud Agent environment setup

**Goal:** bring the `fabdesk` Cloud Agent dev environment fully up (install →
typecheck → test → run `apps/core` and build `apps/desktop`) and demonstrate it
working.

**Status:** **complete.** The GitHub App installation now includes all four
repos (`fabdesk`, `fabplane.com`, `fab_pcb`, `kicad`). On branch
`cursor/verify-dev-environment-50aa` (PR #140), `bash .cursor/install.sh`
initialises both private submodules, `bun run typecheck` and `bun run test`
pass, `apps/core` serves authenticated HTTP + MCP, and `apps/desktop` builds.

Verified on Cloud Agent run that saw:

```text
gh api /installation/repositories → total_count 4
  TensorFleet/fabplane.com
  TensorFleet/fabdesk
  TensorFleet/kicad
  TensorFleet/fab_pcb
```

Evidence log: `/opt/cursor/artifacts/fabdesk-env-verify-evidence.log` on that run.

---

## 1. Background

`fabdesk` is a Bun 1.4.x monorepo (`packageManager: bun@1.4.0`). Two of its
workspaces live in **private git submodules**:

| Submodule path   | Repo                              | Provides                                   |
| ---------------- | --------------------------------- | ------------------------------------------ |
| `vendor/fabplane`| `github.com/TensorFleet/fabplane.com` | shared `tsconfig.base.json`, `@pcb/*` pkgs |
| `vendor/fab_pcb` | `github.com/TensorFleet/fab_pcb`  | `@fp-pcb/proto`, `@fp-pcb/client` workspaces |

Both are **required**: `bun install --frozen-lockfile` aborts if the
`vendor/fab_pcb/packages/{proto,client}` workspaces are missing from disk, and
`apps/core` imports `@pcb/*` and `@fp-pcb/*`.

The environment is repository-managed via `.cursor/environment.json`
(`install: bash .cursor/install.sh`, `start: bash .cursor/start-tailscale.sh`).

---

## 2. Former blocker (resolved)

Previously the Cursor Cloud Agent GitHub App installation on `TensorFleet`
could only read `fabdesk`, so `git ls-remote` / submodule init for
`fabplane.com` and `fab_pcb` failed with `Repository not found`.

That is fixed: the installation now lists all four org repos (see Status
above). Re-check any time with:

```bash
gh api /installation/repositories --jq '.total_count, (.repositories[].full_name)'
```

Repo-side fixes that remain on this branch (PR #140):

- `repositoryDependencies` lists **both** `fabplane.com` and `fab_pcb`
- `.cursor/install.sh` initialises **both** `vendor/fabplane` and `vendor/fab_pcb`

---

## 3. Verified setup steps (agent)

Run from the repo root on branch `cursor/verify-dev-environment-50aa`:

```bash
export PATH="$HOME/.bun/bin:$PATH"

# Token must see the private submodule repos (at least fabdesk + fabplane.com + fab_pcb).
gh api /installation/repositories --jq '.total_count'

bash .cursor/install.sh
git submodule status          # neither line should start with '-'
ls node_modules >/dev/null

bun run typecheck
bun run test                  # NOT bare `bun test` (that recurses into vendor/)

# Core daemon
FABDESK_TOKEN=… bun run --cwd apps/core src/main.ts serve --port 4731 --data-dir /tmp/fabdesk-cloud-verify
# ReadyLine on stdout: {"ok":true,"port":4731,...}
# curl http://127.0.0.1:4731/health
# curl -H "Authorization: Bearer …" http://127.0.0.1:4731/settings
# MCP tools/list over POST /mcp (streamable HTTP) returns core tools

bun run --cwd apps/core src/main.ts doctor --data-dir /tmp/fabdesk-cloud-verify
bun run --cwd apps/desktop build
```

Notes / guardrails (from `AGENTS.md`):

- **Never** run `bun install` inside `vendor/*`; the root lockfile owns all deps.
- Use `bun run test`, not bare `bun test`, so vendor/fab_pcb e2e/web suites are not pulled in.
- `circuit_build` / `route_run` need a FabPlane PCB bridge on `http://127.0.0.1:4020`
  (`FABDESK_FP_PCB_BRIDGE_URL` to override); not required just to boot the daemon
  and list MCP tools.
- Staging login is optional (`TS_AUTH_KEY` + Tailscale).

### Success criteria (all met)

- Installation token can read the private submodule repos.
- `bash .cursor/install.sh` ends with `Setup complete.`; submodules checked out;
  `node_modules/` present.
- `bun run typecheck` passes; `bun run test` passes.
- `apps/core` ReadyLine + authenticated `/settings` + MCP `tools/list`; `doctor` runs.
- `apps/desktop` electron-vite build succeeds.

---

## 4. Pointers

- Repo config fixes: PR #140 (branch `cursor/verify-dev-environment-50aa`),
  touching `.cursor/environment.json` and `.cursor/install.sh`.
- Layout and rules: `README.md`, `AGENTS.md`, `docs/dev-loop.md`.
