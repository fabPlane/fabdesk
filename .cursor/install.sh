#!/usr/bin/env bash
# Idempotent bootstrap for a Fabdesk Cursor Cloud Agent.
#
# Responsibilities (all safe to re-run):
#   1. Install Bun 1.4.0 (the version pinned by package.json / CI).
#   2. Check out the private `vendor/fabplane` submodule, which provides the
#      shared `tsconfig.base.json` and the `@pcb/*` workspace packages that the
#      whole monorepo depends on. Requires the generated GitHub token to have
#      access to `github.com/tensorfleet/fabplane.com` (see repositoryDependencies
#      in environment.json). `vendor/js_autorouter` is internal-only and is left
#      uninitialised; `bun install --frozen-lockfile` skips absent workspaces.
#   3. Install JS dependencies from the root lockfile.
#
# Never run `bun install` inside vendor/* (see AGENTS.md): the root lockfile owns
# every dependency.
set -euo pipefail

BUN_VERSION="1.4.0"

log() { printf '\n\033[1;34m[cloud-setup]\033[0m %s\n' "$*"; }

# --- 1. Bun -----------------------------------------------------------------
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  log "Installing Bun $BUN_VERSION"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
fi

# Make bun discoverable from non-login shells (terminals, agent tools).
# Cloud Agent images keep /usr/local/bin on PATH but root-owned, so the
# previous `-w` check skipped the symlink and later shells could not find bun.
if command -v sudo >/dev/null 2>&1; then
  sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
  sudo ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx
elif [ -w /usr/local/bin ]; then
  ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
  ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx
fi
hash -r 2>/dev/null || true
log "Using $(bun --version) at $(command -v bun)"

# --- 1b. Tailscale (userspace; joined later by start-tailscale.sh) ----------
if ! command -v tailscale >/dev/null 2>&1; then
  log "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop tailscaled.service 2>/dev/null || true
    sudo systemctl disable tailscaled.service 2>/dev/null || true
  fi
fi
log "Tailscale $(tailscale version | head -n 1)"

# --- 2. Private submodules (fabplane + fab_pcb) -----------------------------
# Both submodules are required: vendor/fabplane provides the shared
# tsconfig.base.json and @pcb/* packages; vendor/fab_pcb provides the
# @fp-pcb/{proto,client} workspaces that apps/core depends on. `bun install
# --frozen-lockfile` aborts if either set of workspaces is missing from disk.
init_private_submodule() {
  local path="$1" repo="$2" marker="$3"
  if [ -f "$marker" ]; then
    log "$path already present"
    return 0
  fi
  log "Initialising $path submodule"
  if git submodule update --init --depth 1 "$path"; then
    return 0
  fi
  cat >&2 <<EOF

[cloud-setup] ERROR: could not fetch the private submodule $repo

Fabdesk's shared TypeScript config, @pcb/* and @fp-pcb/* packages live in the
private repos github.com/tensorfleet/fabplane.com and github.com/tensorfleet/fab_pcb.
Without them, \`bun install\`, \`bun run typecheck\` and the apps/core + apps/desktop
apps cannot run.

Grant access by either:
  * keeping "github.com/tensorfleet/fabplane.com" and
    "github.com/tensorfleet/fab_pcb" in repositoryDependencies in
    .cursor/environment.json AND granting the Cursor GitHub App access to both
    repositories, or
  * providing a read-only submodule deploy key as an environment secret.

EOF
  return 1
}

init_private_submodule vendor/fabplane github.com/tensorfleet/fabplane.com vendor/fabplane/tsconfig.base.json
init_private_submodule vendor/fab_pcb github.com/tensorfleet/fab_pcb vendor/fab_pcb/packages/proto/package.json

# --- 3. JS dependencies -----------------------------------------------------
log "Installing dependencies (bun install --frozen-lockfile)"
bun install --frozen-lockfile

log "Setup complete."
