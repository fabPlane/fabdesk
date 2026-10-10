# Install-on-demand autorouters

Settings → **Routers** lists every catalog router, its install state, and a default picker.
Route Cinema’s empty state has the same picker. Agents pass `router` on `route_run`.

Unpinned projects still default to **Freerouting → fab_router fallback**. Nothing changes
until you pick a router in Settings, pin `fabdesk.json`, or pass `route_run.router`.

| id | How it is installed | Strengths (team comparison) |
|---|---|---|
| `fab_router` | Bundled on the PCB bridge | Fast iteration, automatic selective reroutes, Freerouting fallback |
| `freerouting` | Bundled in packaged desktop builds; otherwise downloaded (GPL-3.0 JAR) | Best simple-board routing quality |
| `tracemaker` | Weekly TensorFleet binary (source tarball fallback) | Best whole-board routing and dense pads |

## TraceMaker size and license

TraceMaker is [DingoOz/TraceMaker](https://github.com/DingoOz/TraceMaker), C++20, **GPL-3.0-or-later**.

Official upstream releases do not include a router binary (the `v0.8.0` zip is an 8.7 KB
KiCad plugin; `v0.9.0` has no assets). fabdesk therefore builds our own binaries weekly
(`.github/workflows/tracemaker-binaries.yml`) and publishes them as GitHub release assets
on this repo.

**Install** (Settings → Routers) does this:

1. Honour `TRACEMAKER_BIN` if it points at an existing binary.
2. Fetch the public rolling manifest
   `https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json`
   (overridable via `FABDESK_TRACEMAKER_MANIFEST_URL` or Settings), pick the asset for the
   current OS/arch, and download it with SHA-256 verification.
3. If that host is unreachable, or has no asset for this platform, fall back to the
   pinned upstream source tarball. The package is then `installed` but **not ready** until
   you build it or set `TRACEMAKER_BIN`.

Each published archive contains the upstream `LICENSE` (and `NOTICE` when present) plus
`SOURCE.txt` with the pinned upstream tag and commit. That is the GPL-3.0 §6 source offer
for the binary. Linux builds are unmodified upstream. macOS builds of the pinned `v0.9.0`
commit also apply `scripts/tracemaker/patches/24c847772e57ea8888e2cfe4bbf1aa00666390a4.patch`
(Apple libc++ `from_chars(double)` plus `#include <cstdlib>` for `std::atof`); that patch is named in `SOURCE.txt` when used.

Measured 2026-10-09 (source fallback, still used when no binary exists for the platform):

- Git clone: **47 MB** uncompressed (about 20 MB of that is `report/` PDFs)
- C++ sources: **2.0 MB** / 149 files
- Tagged `v0.8.0` source tarball: **20,863,170 bytes (~19.9 MiB)**, SHA-256
  `1d77e994c5b44d51ff885c1a2081f61c3ee94f96d4136922bbb640f3f7904b68`
- GitHub `v0.8.0` zip asset: **8.7 KB** (KiCad plugin only — not a router binary)
- `v0.9.0` has no upstream release assets

### Binary platforms and linkage

| Platform | Built? | Preset | Notes |
|---|---|---|---|
| `linux-x86_64` | yes | `cpu-only` on Ubuntu 26.04 / GCC 15 | No CUDA. Non-system libs (zstd, sqlite) are bundled with `$ORIGIN/lib` when present. Remaining dynamic deps are glibc. |
| `macos-arm64` | yes | `macos-metal` | Two variants in one job; **publish the first that passes smoke**. **A (preferred):** Apple clang + system `/usr/lib/libc++.1.dylib` (single C++ runtime; Metal/Foundation already load Apple libc++). **B:** Homebrew LLVM `clang++` + **static** `libc++` / `libc++abi` / `libunwind` (run 38016562996 linked B then SIGABRT on `--help`). Both apply the v0.9.0 `from_chars(double)` + `<cstdlib>` patch and `-Werror=unguarded-availability-new` on A. `CMAKE_OSX_DEPLOYMENT_TARGET=15.0`. SQLite: isolated headers + static `libsqlite3.a` or `/usr/lib/libsqlite3.dylib`. zstd is **static** `libzstd.a`. `--help` / `version` do not call Metal (`MTLCopyAllDevices` is lazy; smoke uses `route --no-gpu`). Smoke abort uploads unpackaged binaries + `lldb` / `DYLD_PRINT_LIBRARIES` / crash reports as `tracemaker-macos-arm64-debug`. Manifest records `minos=15.0`, `cxxRuntime`, and `macosVariant`. |
| `macos-x86_64` | no | — | Intel macOS runners are not cheap enough for a weekly job; brew bottles on the arm64 runner are arm64. |
| `windows-x86_64` | best-effort | no upstream preset; MSYS2 UCRT64 + Ninja | GCC-only `Warnings.cmake` and the `base` preset's Unix `PATH` rule out MSVC. Static libgcc/libstdc++ / zstd / sqlite. Archive is `.zip` with `tracemaker.exe`. A Windows failure does not block linux/macos. |

Users do not need CMake or a C++ toolchain to *install* a published binary. They still need
a matching OS/arch (glibc x86_64 Linux, Apple silicon macOS 15+, or 64-bit Windows).

Release tags: immutable `tracemaker-<upstream-tag>-<shortsha>`, plus a rolling
`tracemaker-latest` pointer whose `manifest.json` lists checksums and points at the
immutable asset URLs. Both use `--latest=false` so they do not become the repo's GitHub
"Latest release" (that stays the desktop installer). The workflow skips the whole run
when that immutable tag already lists every **required** platform and any missing
**optional** platform (Windows) has been waived after
`TRACEMAKER_OPTIONAL_FAIL_LIMIT` (default 3) consecutive failures. A missing Windows
entry still triggers a Windows-only rebuild next week until it is published or waived.
`workflow_dispatch` input `force` rebuilds every expected platform and clears the waiver.

The team’s comparison is not checked into this repo. TraceMaker’s own harness is
`bench/compare.py` / `bench/run.py` in that project (PCBench + Freerouting baselines).
fab_pcb’s older five-board JS vs Freerouting table remains in `vendor/fab_pcb/docs/router-comparison.md`.

## Install states and failures

- **Ready means a runnable file.** TraceMaker is `ready` only when the saved path (or a binary found inside the
  package directory) is an executable regular file. A source tarball install (no published binary for this
  OS/arch, or the release manifest is not published yet) is `installed` but **not ready** ("source only · not
  built"): the card says why it fell back, and the picker and *Set default* stay disabled until you build it in
  the package directory (the registry then finds the binary) or set `TRACEMAKER_BIN`. *Check for binary* re-runs
  the install once a release exists.
- **Failures stay on the card.** The real error (offline, checksum mismatch, HTTP status, extraction) is shown
  with a Retry button. Installs download and extract into a scratch directory and are swapped in only when
  complete, so a failed or cancelled install leaves nothing half-installed.
- **Progress.** While installing, the card shows bytes received / total (determinate bar), then *Verifying
  checksum…* and *Extracting…*; Cancel aborts the download.
- **Defaults.** Uninstalling the router that is the saved default resets the default to automatic. A saved
  default that is no longer ready (e.g. `TRACEMAKER_BIN` removed) makes unpinned `route_run` fall back to the
  automatic path with a fallback note instead of failing; an explicit `router` still returns the install hint.
- **`TRACEMAKER_BIN` / `FREEROUTING_JAR`** routers are labelled with the env var, show the version reported by
  `tracemaker version` (then `--version`), and have no Uninstall (unset the variable instead).
- **Local fixture for demos.** Point `FABDESK_TRACEMAKER_MANIFEST_URL` (or Settings → Routers → TraceMaker
  manifest URL) at a local server that serves a manifest (and a throttled asset) to exercise progress,
  checksum-mismatch and 404 paths without a real release.

## Public download channel

Desktop installers already use `https://downloads.fabplane.com/desktop/<tag>/…` on the
`fabplane-downloads` R2 bucket (see `docs/releases.md` and fabplane.com
`docs/desktop-releases.md`). TraceMaker reuses that **same public host** under a
`tracemaker/` prefix:

| Role | URL |
|---|---|
| Shipped default manifest | `https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json` |
| Versioned archive | `https://downloads.fabplane.com/tracemaker/<immutable-tag>/tracemaker-<platform>.tar.gz` (or `.zip` on Windows) |
| Private GitHub copy (CI merge only) | `https://github.com/TensorFleet/fabdesk/releases/download/<tag>/…` (404 for anonymous users) |

The weekly `publish` job still writes the private GitHub release (so the next run can
merge checksums). `scripts/tracemaker/mirror-public.sh` then rewrites asset URLs onto the
public base, uploads archives + `manifest.json`, and **re-downloads each public URL to
compare sha256**. sha256s in the mirrored manifest are identical to the private ones.

The shipped app never embeds a GitHub token. Install therefore:

1. Honours `TRACEMAKER_BIN`.
2. Fetches the manifest from `FABDESK_TRACEMAKER_MANIFEST_URL`, else Settings → Routers → TraceMaker
   manifest URL, else `TRACEMAKER_PUBLIC_MANIFEST_URL` (the downloads.fabplane.com constant).
3. Falls back to the public upstream source tarball, with a card notice that the public
   downloads host was unreachable (or that a private GitHub override 404'd).

### Owner configuration (fabdesk repository)

The mirror step **skips with a notice and exits 0** when credentials are unset. It must
never fail the private GitHub release. The owner creates these (do not commit values):

**Recommended — same R2 bucket as desktop installers**

| Name | Kind | Example / notes |
|---|---|---|
| `TRACEMAKER_PUBLIC_BASE_URL` | variable | `https://downloads.fabplane.com/tracemaker` |
| `TRACEMAKER_S3_BUCKET` | variable | `fabplane-downloads` |
| `TRACEMAKER_S3_ENDPOINT` | variable | `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `TRACEMAKER_S3_REGION` | variable | `auto` (optional) |
| `TRACEMAKER_S3_PREFIX` | variable | `tracemaker` (optional; object key is `<prefix>/<tag>/<file>`) |
| `TRACEMAKER_S3_ACCESS_KEY_ID` | secret | R2 S3 access key id, scoped to `fabplane-downloads` (or `tracemaker/*`) |
| `TRACEMAKER_S3_SECRET_ACCESS_KEY` | secret | R2 S3 secret access key |

Also accepted, if the owner copies the **desktop** trio onto this repo instead of the
`TRACEMAKER_S3_*` pair:

| Name | Kind | Notes |
|---|---|---|
| `DESKTOP_R2_ACCESS_KEY_ID` | variable | Same as fabplane.com desktop-release.yml |
| `CLOUDFLARE_ACCOUNT_ID` | secret | R2 account id |
| `CLOUDFLARE_API_TOKEN` | secret | Secret key is `SHA-256(token)` (Cloudflare S3 credential derivation) |

Extend the existing `fabplane-downloads` token to allow object write under `tracemaker/`
if it is prefix-scoped. Custom domain `downloads.fabplane.com` already serves the bucket.

**Alternative — owner-created public GitHub repo**

Do **not** make TensorFleet/fabdesk public from this PR. If the owner prefers a public
release repo:

| Name | Kind | Notes |
|---|---|---|
| `TRACEMAKER_PUBLIC_RELEASE_REPO` | variable | e.g. `TensorFleet/fabdesk-tracemaker` — **create the public repo yourself** |
| `TRACEMAKER_PUBLIC_RELEASE_TOKEN` | secret | PAT with Contents: write on that repo only |

The shipped default URL stays `downloads.fabplane.com`. A public-repo-only mirror is
useful as a backup; users will not see it unless R2 is also configured or the app
constant / Settings override is changed.

## Test on a Mac (no staging login)

You do not need `api.fabplane.com` or Tailscale staging for this.

```bash
# from the fabdesk repo
bun install
bun run --filter @fabdesk/tools test test/router-registry.test.ts test/router-option.test.ts test/tracemaker-release.test.ts
bun run --filter @fabdesk/ui test src/settings/routers.test.ts

# optional: point at a binary you built from DingoOz/TraceMaker
export TRACEMAKER_BIN="$HOME/src/TraceMaker/build/macos-metal/src/app/tracemaker"
# then Settings → Routers should show TraceMaker as installed, or:
# route_run { "router": "tracemaker" }
```

Desktop Freerouting is already bundled when `FREEROUTING_JAR` is set by the PCB supervisor.
If it is missing, Settings → Routers → Install downloads
`https://github.com/freerouting/freerouting/releases/download/v2.4.1/freerouting-2.4.1.jar`
(SHA-256 `251101c3eeac22d7e7dfcf6796603279e5d1000283eb82d8f093780f7afc6aa9`) into
`routers/freerouting/`. The running bridge still reads `FREEROUTING_JAR` at start; restart the
desktop app after a first-time Freerouting install.

Tests can override artifact URLs and checksums with `FABDESK_TRACEMAKER_URL`,
`FABDESK_TRACEMAKER_SHA256`, `FABDESK_FREEROUTING_URL`, and `FABDESK_FREEROUTING_SHA256`.
The binary release pointer is `FABDESK_TRACEMAKER_MANIFEST_URL` (wins) /
Settings `tracemakerManifestUrl` /
`FABDESK_TRACEMAKER_RELEASE_TAG` / `FABDESK_TRACEMAKER_RELEASE_REPO`. Setting
`FABDESK_TRACEMAKER_URL` disables the binary lookup and uses the source artifact.

The weekly workflow publishes `linux-x86_64` and `macos-arm64`, and best-effort
`windows-x86_64`. A partial immutable tag is completed on the next run: missing platforms
are built, uploaded with `--clobber`, and merged into `manifest.json` after the existing
archives are checksum-verified. Windows failures increment `platform-status.json` on the
tag; after three consecutive failures Windows is waived so the weekly run can stay green
and skip. `workflow_dispatch` input `force` rebuilds every expected platform.
`tracemaker-latest` is never GitHub’s “Latest” release.

### Dispatch (owner)

```bash
gh workflow run tracemaker-binaries.yml --repo TensorFleet/fabdesk --ref <this-branch>
# after a known-good Windows + public-mirror run, the same on main
```

Check: linux/macos/windows job results, the run summary (Windows pending/failed/waived),
the private `tracemaker-*` GitHub release, then anonymous
`curl -fsSI https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json`
and sha256 of each rewritten archive URL. This agent cannot dispatch Actions.
