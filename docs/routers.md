# Install-on-demand autorouters

Settings → **Routers** lists every catalog router, its install state, and a default picker.
Route Cinema’s empty state has the same picker. Agents pass `router` on `route_run`.

Unpinned projects still default to **Freerouting → fab_router fallback**. Nothing changes
until you pick a router in Settings, pin `fabdesk.json`, or pass `route_run.router`.

| id | How it is installed | Strengths (team comparison) |
|---|---|---|
| `fab_router` | Bundled on the PCB bridge | Fast iteration, automatic selective reroutes, Freerouting fallback |
| `freerouting` | Bundled in packaged desktop builds; otherwise downloaded (GPL-3.0 JAR) | Best simple-board routing quality |
| `tracemaker` | Weekly fabPlane binary (source tarball fallback) | Best whole-board routing and dense pads |
| `krt` | Pinned upstream release + a private Python venv (see below) | Engine, not a `route_run` router: the board workflow's placer and KRT router |

## KiCadRoutingTools (engine)

[KiCadRoutingTools](https://github.com/drandyhaas/KiCadRoutingTools) (KRT, **MIT**, Python + a Rust core) is what
`board_route` places and routes with, and what every last-mile router, rip and nudge step runs. It sits in Settings →
Routers as **KiCadRoutingTools** with `kind: "engine"`: it has Install / Uninstall / Reinstall like the routers, but no
*Set default* and no entry in the Route Cinema picker or `route_run.router`.

**Where the board tools find it** (`krtDir` in `packages/tools/src/tools/board-host.ts`):

1. Settings `krtDir` (Settings → Routers → *KiCadRoutingTools folder*), returned as given so a wrong path fails the
   layout `check` by name;
2. env `FABDESK_KRT_DIR`;
3. the installed copy, `<fabdesk data dir>/routers/krt`.

A build is any folder with `src/plugins/py_router/route.py`, a venv interpreter (`venv/bin/python`, or
`venv\Scripts\python.exe` on Windows) and `src/plugins/rust_router/grid_router.{so,pyd}`. The card shows an override
as `installed (Settings krtDir)` / `(FABDESK_KRT_DIR)`, or says why a set path is not a build.

**Install** (`packages/tools/src/routers/krt.ts`):

1. Download `KiCadRoutingTools-0.23.8.zip` from the upstream GitHub release (16,067,806 bytes), verify SHA-256
   `0179da836e6d41484701a9b840e2e30e94465cd7dc1c226e0c7bf850fe78453f`, extract it into `routers/krt/src`.
   (`FABDESK_KRT_URL` / `FABDESK_KRT_SHA256` override both, for a mirror.)
2. Copy the bundled Rust core for this OS/arch (`grid_router-{linux-x86_64,macos-arm64,macos-x86_64}.so`,
   `grid_router-windows-x86_64.pyd`) to `grid_router.so` / `.pyd`, the name KRT's CLIs import (KRT's own
   `_resolve_rust_binary` does this inside KiCad). Linux arm64 and Windows arm64 have no prebuilt core: see *ARM* below.
3. Make `routers/krt/venv` and install the routing packages from the **hash lock** `packages/tools/src/routers/krt-lock.json`
   (`numpy==2.5.4 scipy==1.18.1 shapely==2.2.0`, what every parity run used, each with the sha256 of every wheel and
   the sdist PyPI lists; written to `routers/krt/krt-requirements.txt` and installed with `--require-hashes
   --only-binary :all: --no-deps` on both the uv and the pip path). The lock's numpy needs **CPython ≥ 3.12**. The first
   of these that takes the lock wins:
   - `FABDESK_KRT_PYTHON` when set (used alone, so a wrong or too-old value fails loudly);
   - **uv** found on the machine (`FABDESK_KRT_UV`, PATH, `~/.local/bin`, `~/.cargo/bin`, Homebrew): a uv-managed
     CPython 3.12 kept inside the install (`routers/krt/python`), so it matches the parity runs, goes with Uninstall and
     survives OS Python upgrades;
   - a system Python ≥ 3.12: Linux `python3`, `python3.13`, `python3.12`; macOS python.org, Homebrew, KiCad.app's bundled
     Python, and `/usr/bin/python3` only when the Command Line Tools are installed (else it is a stub that opens an
     install dialog); Windows the `py -3` launcher, `python` on PATH (not the Store alias), then KiCad's `bin\python.exe`.
     The venv is made by uv when uv exists (no `ensurepip` needed), else `python -m venv` + pip. Older Pythons (KiCad's
     bundled 3.9-3.11 among them) are skipped with the reason;
   - otherwise a **pinned uv** is downloaded into the fabdesk data dir (`routers/uv/0.13.6/`, `packages/tools/src/routers/uv.ts`)
     and provisions the managed CPython 3.12, so a machine with no Python, uv or compiler installs KRT unaided.
   - **Pillow** (raster previews) and **ortools** (the bus step, ~100 MB) are optional in KRT's `requirements.txt`
     and are not installed: none of the scripts the workflow runs (route, route_diff, route_planes, place_simple,
     check_floorplan, check_groups, net_forensics, make_unplaced) imports them on the paths it uses.
4. Import check: the venv imports numpy, scipy, shapely and `grid_router` together.

uv runs with `UV_NO_CONFIG=1 UV_NO_CACHE=1 UV_LINK_MODE=copy`: nothing goes to the user's uv cache or config, everything
lands in the install. The venv is made in place after the extracted tree is swapped in (venv paths are absolute); any
failure restores the previous install. When nothing works the card says what was tried and what to do. fabdesk itself
ships no Python. The old fallback to KRT's floors (`numpy>=1.22 ...`, unhashed) for a Python without wheels for the
pins is gone: with the uv bootstrap every supported platform reaches a Python that takes the lock, and a floor install
would be neither hashed nor the versions the reference runs used.

**The pinned uv.** uv 0.13.6 (released 2026-10-27). One archive per platform, checked against the sha256 astral-sh/uv
publishes for the release (`sha256.sum`, which matches GitHub's asset digests); Linux uses the static musl builds:

| Platform | Asset | SHA-256 |
| --- | --- | --- |
| linux x64 | `uv-x86_64-unknown-linux-musl.tar.gz` | `5d61f26b6c7213779eda90edc6971ea6b0b796bfb8d49a574c8ad69b59838548` |
| linux arm64 | `uv-aarch64-unknown-linux-musl.tar.gz` | `819692e404d23e5aae6bc44c0e260f1f5492fd1910ab4693b2c650f926dbe800` |
| macOS arm64 | `uv-aarch64-apple-darwin.tar.gz` | `60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472` |
| macOS x64 | `uv-x86_64-apple-darwin.tar.gz` | `63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02` |
| windows x64 | `uv-x86_64-pc-windows-msvc.zip` | `a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f` |
| windows arm64 | `uv-aarch64-pc-windows-msvc.zip` | `c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c` |

uv verifies the CPython it downloads (python-build-standalone) against its own built-in sha256 table. To bump: change
`UV_VERSION` and the table in `uv.ts` from the new release's `sha256.sum`. To regenerate the lock: see its `about` field.

**ARM.** KRT 0.23.8 ships `grid_router` for linux-x86_64, macos-arm64/x86_64 and windows-x86_64 only, and has no
pure-Python fallback (`py_router/*` import `grid_router` unconditionally). On linux-arm64 and windows-arm64 the
install builds it from the zip's `rust_router/` (`cargo build --release`, `PYO3_PYTHON` = the venv's Python,
`CARGO_TARGET_DIR` inside the install, the result copied to `grid_router.so` / `.pyd`) when cargo is found
(`FABDESK_KRT_CARGO`, PATH, `~/.cargo/bin`); without it the install stops before any Python download with "building it
needs Rust (cargo, https://rustup.rs) and a C compiler". **rustup is not bootstrapped**: a minimal toolchain is a
~250-300 MB download, and it still would not be enough, since the crate also needs a system linker and C compiler
(mimalloc's build script; the MSVC Build Tools on Windows, several GB), so it cannot make those machines zero-prerequisite.
The release ships no `Cargo.lock`, so a source build resolves the `pyo3 0.23` / `numpy 0.23` / `mimalloc 0.1` ranges at
build time (not reproducible; not verified on real ARM hardware).

**Install on first use.** The board tools call the registry's `ensure` (`packages/tools/src/routers/registry.ts`) through
the layout host (`engineEnsurer` in `board-host.ts`, `engineReady` in `@fabdesk/board-workflow`'s `layout/ctx.ts`) at the
point a step needs an engine: the layout `check` (KRT and TraceMaker), `place` / `rank` / `route` (KRT; TraceMaker for
the route stage's TraceMaker branch), the last-mile router, rip and nudge steps and `why` (KRT), and `fill:tracemaker`.
The missing engine is installed inline with progress lines and the step continues. Rules:

- concurrent requests share one install (one download), whether they come from parallel candidates, two tools or
  Settings;
- an override that is set (Settings `krtDir`, `FABDESK_KRT_DIR`, `TRACEMAKER_BIN`) is used as given; when it is broken
  that is reported and nothing is installed over it;
- Settings `autoInstallEngines` (default on; Settings → Routers → *Install engines on first use*) turns it off: the
  steps then report the missing engine;
- an automatic install that failed is not retried automatically in the same core process; `board_engines install`
  (or Settings → Install) retries;
- `route_run router=tracemaker`, `why`'s cause classes and `validate`'s pair audit install TraceMaker on first use as well;
- the floorplan path (`board_route action=floorplan`, `block_eval`, last-mile `replace:`) runs TraceMaker's placer
  `tracemaker-place` through `ensurePlacer` (`placerEnsurer` in `board-host.ts`, `tracemakerPlacer` in
  `layout/floorplan.ts`); see [TraceMaker's placer](#tracemakers-placer-tracemaker-place).

The agent can also see and install engines itself with the `board_engines` tool (`board` toolset, global): `status`
lists each engine's state, path, override and last error (and, under TraceMaker, `placer:` with where `tracemaker-place`
is or why it is missing) plus kicad-cli and the auto-install setting; `install` (`engine`: krt, tracemaker, freerouting,
or all = krt + tracemaker; tracemaker also upgrades an install whose archive predates the placer) runs as a durable
board job. Programmatic callers
(CI) keep using `registry.install("krt")`.

Measured 2026-11-12 on Linux x86_64, **cold** on a bare-machine simulation (empty HOME, PATH without uv or Python, a
fresh data dir): about **39 s** in all (uv download 3 s, managed CPython 1 s, hash-locked wheels 33 s); a second run on a
slow link spent 14 min on the wheels alone (uv prints nothing meanwhile, so the install logs a heartbeat every minute); about **320 MB**
on disk for KRT (scripts, venv, managed CPython) plus 42 MB for the pinned uv. A cold install downloads ~16 MB of
KRT, ~18 MB of uv, ~30 MB of CPython and ~60 MB of wheels.

## atlc (engine)

`board_review section` (finite-difference cross-section impedance, the toolkit's `review/atlc_section.py`) runs atlc 4.6.1
(GPL-2.0-or-later, https://atlc.sourceforge.net) as a separate program. Upstream publishes source only, so the registry entry
`atlc` (kind `engine`) downloads Debian's pristine copy of the upstream tarball
(`https://deb.debian.org/debian/pool/main/a/atlc/atlc_4.6.1.orig.tar.bz2`, 1 784 110 bytes, sha256 `0ad8f9bb…6841321`;
`FABDESK_ATLC_URL` / `FABDESK_ATLC_SHA256` override) and builds `atlc-4.6.1/src/atlc` with `sh ./configure CFLAGS="-O2 -fcommon"`
and `make -C src atlc` (single-threaded, like Debian's package; a few seconds; needs a C compiler and make). `ATLC_BIN` wins, then an
`atlc` on PATH (the Debian/Ubuntu `atlc` package) is used as it is. Windows has no build path: set `ATLC_BIN`. Verified on Linux x86_64
(the built binary gives the same impedances as Debian's on the C6 stack106 sections); macOS is untested (the 2008 `config.guess` may
not know arm64 Macs: then install atlc another way and set `ATLC_BIN`).

## TraceMaker size and license

TraceMaker is [DingoOz/TraceMaker](https://github.com/DingoOz/TraceMaker), C++20, **GPL-3.0-or-later**.

Official upstream releases do not include a router binary (the `v0.8.0` zip is an 8.7 KB
KiCad plugin; `v0.9.0` has no assets). fabdesk therefore builds our own binaries
(`.github/workflows/tracemaker-binaries.yml`) and publishes them on downloads.fabplane.com.

**The build fabdesk installs is pinned** in `packages/tools/src/routers/tracemaker-pin.json`: a copy of one
immutable release's `manifest.json` (upstream tag and commit, and each platform archive's URL and sha256).
TraceMaker stays on this known, pinned build. Change it only when a fix or feature is needed:

1. Dispatch `tracemaker-binaries.yml` with a required upstream tag or commit (`upstream_ref`).
2. Check router and placer smoke results, then verify the public archive hashes.
3. Download that immutable public manifest and run
   `python3 scripts/tracemaker/update-pin.py <public-manifest.json> packages/tools/src/routers/tracemaker-pin.json`.
   This copies the verified manifest byte-for-byte; never edit hashes by hand.
4. Open one PR against `main` with the updated pin and run the app's registry upgrade test and shipped-pin gate.

There is no schedule or automatic PR. Each dispatch builds a fresh version named
`tracemaker-<tag>-<commit7>-b<GitHub run ID>-<attempt>`; retries and rebuilds get distinct names.
The mirror preflights all versioned keys in authenticated storage and uses conditional create-only uploads.
Lookup errors stop publication; existing objects are never overwritten.

**Install** (Settings → Routers) does this:

1. Honour `TRACEMAKER_BIN` if it points at an existing binary.
2. Take the pinned manifest (`tracemaker-pin.json`, no network lookup), or the manifest at
   `FABDESK_TRACEMAKER_MANIFEST_URL` / Settings when one is set (for trying a build before pinning it), pick the
   asset for the current OS/arch, and download it with SHA-256 verification.
3. If that host is unreachable, or has no asset for this platform, fall back to the
   pinned upstream source tarball. The package is then `installed` but **not ready** until
   you build it or set `TRACEMAKER_BIN`.

### TraceMaker's placer (`tracemaker-place`)

Every published archive carries upstream's placer `tracemaker-place` (`.exe` on Windows) beside `tracemaker`: `build.sh`
builds both CMake targets (`src/place` has existed since v0.8.0, and its CLI is the one `floorplan.ts` calls:
`board -o out --mode full --time --seed --courtyard-clearance-mm --json`), `package.sh` gives it the same strip, library
bundling (`$ORIGIN/lib` on Linux, DLLs beside the `.exe` on Windows), Windows DLL probe and macOS ad-hoc signature, and
`smoke.sh` runs `tracemaker-place --help` (checking those flags) and a 2-part placement on the smoke fixture (checking
the `legalisation: N placed, M failed` and `conflicts before … after … new …` lines and the `--json` report's
`fixed_parts`, which the floorplan passes parse). On macOS both programs pass `verify-macos.sh` for the variant that is
published. `asset.json` / the manifest name it (`"placer": "tracemaker-place"`).

The registry resolves it (`traceMakerPlacerNear`, the snapshot's `placer` field, `ensurePlacer`):

1. `TRACEMAKER_PLACE_BIN` when set (a broken value is reported, never installed over);
2. beside the TraceMaker binary (the installed archive, an upstream install's `bin/`, or `TRACEMAKER_BIN`'s folder);
3. the CMake build tree's `src/place` next to `src/app` (a source build, including `TRACEMAKER_BIN` pointing into one),
   then anywhere in a source package built in place.

`ensurePlacer` installs TraceMaker first when it is missing (the same rules as `ensure`). A managed install from an
archive that predates the placer (no `placer` key) is replaced once from the current release, but only after the
manifest shows that release carries it, so nothing is re-downloaded for nothing; automatic upgrades honour
`autoInstallEngines` and are not retried after a failure (`board_engines install tracemaker` retries). A
`TRACEMAKER_BIN` or source-package install is never replaced; the reason says what to build or set.
A reviewed pin change supplies the first placer-capable build; old archive URLs remain byte-identical.

Each binary archive contains upstream `LICENSE`, `NOTICE`, `SOURCE.txt`, dependency license texts in `licenses/`,
and `corresponding-source/` with pristine upstream commit source, the exact build patch, build scripts,
the dependency-install workflow, and matching dependency source inputs with SHA-256 inventories.
The same source bundle is retained beside the binary archives on our immutable release. `SOURCE.txt` points to
that copy first and upstream second, and records its SHA-256. Missing dependency notices stop packaging.
Linux resolves actual header/runtime file owners (including versioned Boost), and copies their copyright
files plus the full common-license texts they reference; Windows copies
MSYS2 package license directories; macOS extracts notices from Homebrew's verified matching-version sources.
The macOS static LLVM variant includes LLVM notices; a bundled static SQLite includes SQLite notices.
License validation reads the notices and requires the relevant license text or identifier, including Boost's
BSL rather than the boost-defaults metapackage's MIT notice. Debian source inputs are the exact installed
source versions' `.dsc`, upstream archives and distribution patches. Homebrew retains the matching formula,
version metadata, upstream archive and patched tree; MSYS2 retains the matching packaging commit and
`makepkg --allsource` archive, including distribution patches. Missing versions fail packaging.
OS libraries and general-purpose build tools are excluded. Sources for copied GCC runtimes, compiled-in C++ implementation/configuration headers, and static LLVM/Windows runtimes are retained.

On a Linux build host with `deb-src` enabled, collect and reconstruct dependency inputs offline:

```sh
python3 scripts/tracemaker/linux-dependencies.py sources "$RUNNER_TEMP/tm-inputs"
# From here, reconstruction does not use the network and checks every retained file hash.
python3 scripts/tracemaker/linux-dependencies.py reconstruct "$RUNNER_TEMP/tm-inputs" "$RUNNER_TEMP/tm-reconstructed"
```

`--cache DIR` on `sources` accepts previously downloaded matching apt source packages instead of fetching.
`test-pin.py` reconstructs a fixture through real `dpkg-source`, checks that a distro patch applies,
and rejects corrupt inputs. It does not claim to build TraceMaker offline without a provisioned toolchain.


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
| `macos-x86_64` | no | — | Intel macOS runners are not included in this build matrix; brew bottles on the arm64 runner are arm64. |
| `windows-x86_64` | best-effort | no upstream preset; MSYS2 UCRT64 + Ninja | GCC-only `Warnings.cmake` and the `base` preset's Unix `PATH` rule out MSVC. Static libgcc/libstdc++ / zstd / sqlite. Archive is `.zip` with `tracemaker.exe` and `tracemaker-place.exe`. A Windows failure does not block linux/macos. |

Users do not need CMake or a C++ toolchain to *install* a published binary. They still need
a matching OS/arch (glibc x86_64 Linux, Apple silicon macOS 15+, or 64-bit Windows).

Release tags are immutable `tracemaker-<upstream-tag>-<shortsha>-b<run-id>-<attempt>`.
The rolling `tracemaker-latest` manifest points at immutable asset URLs. Both GitHub
releases use `--latest=false` so the desktop installer remains the repo's “Latest”.
Every dispatch builds all configured platforms for the explicitly requested ref, even if it already matches
the shipped pin. Each attempt creates a new version; it never replaces the previous build.

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
| Shipped default manifest | the pinned copy in `packages/tools/src/routers/tracemaker-pin.json` (not fetched) |
| Rolling pointer (not used by default) | `https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json` |
| Versioned archive | `https://downloads.fabplane.com/tracemaker/<immutable-tag>/tracemaker-<platform>.tar.gz` (or `.zip` on Windows) |
| Private GitHub build copy | `https://github.com/TensorFleet/fabdesk/releases/download/<tag>/…` (404 for anonymous users) |

The manually dispatched `publish` job writes the private GitHub release. `scripts/tracemaker/mirror-public.sh` then rewrites asset URLs onto the
public base, uploads archives + `manifest.json`, and **re-downloads each public URL to
compare sha256**. sha256s in the mirrored manifest are identical to the private ones.

The shipped app never embeds a GitHub token. Install therefore:

1. Honours `TRACEMAKER_BIN`.
2. Uses the manifest at `FABDESK_TRACEMAKER_MANIFEST_URL`, else Settings → Routers → TraceMaker manifest URL, else
   the pinned manifest (`TRACEMAKER_PINNED_MANIFEST`, from `tracemaker-pin.json`; nothing is fetched).
3. Falls back to the public upstream source tarball, with a card notice that the public
   downloads host was unreachable (or that a private GitHub override 404'd).

### Owner configuration (fabdesk repository)

The mirror step **skips with a notice and exits 0** when credentials are unset.
When credentials are configured, a failed upload or sha256 re-check **exits non-zero**
(the private GitHub release from the publish step is not rolled back). The mirror job
also runs when the immutable tag already exists, so a completed release still uploads
`tracemaker-latest/manifest.json`. The owner creates these (do not commit values):

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

The manually dispatched workflow builds `linux-x86_64`, `macos-arm64`, and best-effort `windows-x86_64`.
A pin PR requires both required platforms; each included asset must carry the placer.
Retry missing platforms with another explicit dispatch, which creates a whole new version.
A configured mirror that fails an upload or hash check fails its job; only a successfully verified public manifest should be used for a pin PR.
`tracemaker-latest` is a rolling discovery pointer, never the shipped default or GitHub's “Latest” release.

### Dispatch (owner)

```bash
gh workflow run tracemaker-binaries.yml --repo fabPlane/fabdesk --ref <this-branch> -f upstream_ref=<known-tag-or-commit>
# after a known-good Windows + public-mirror run, the same on main
```

Check: linux/macos/windows job results and the run summary,
the private `tracemaker-*` GitHub release, then anonymous
`curl -fsSI https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json`
and sha256 of each rewritten archive URL. After verifying the versioned public manifest and its archives:

```bash
python3 scripts/tracemaker/update-pin.py <public-manifest.json> packages/tools/src/routers/tracemaker-pin.json
python3 scripts/tracemaker/test-shipped-pin.py
bun run test # includes packages/tools/test/tracemaker-pin-upgrade.test.ts
```

Open one reviewed PR against `main` containing the pin change. The workflow does not open a PR.
