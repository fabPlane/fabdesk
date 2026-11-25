# Releases and updates

## Release line 0.3

The canvas workspace change starts the **0.3** minor line. The checked-in root,
desktop and core manifests use `0.3.0`; the mobile app config is stamped by the
same version helper. Public releases continue to use `0.3.<workflow run number>`.
The next release includes the canvas workspace notes in `release-notes.json`.
Changing this baseline or merging the PR does not itself publish a release.

## Pipeline

1. **Nightly (20:00 UTC / 03:00 Asia/Bangkok) or manual public run** → `.github/workflows/release.yml` runs.
   - Version is `<major>.<minor>.<run_number>` where `<major>.<minor>` comes from the root
     `package.json` (bump that to start a new minor line). `scripts/set-version.ts` stamps it
     into the app manifests before building.
   - TypeScript is checked once on Linux before the native build matrix starts. Four runners then
     build `fabdesk-core` for their own target, stage the FabPlane KiCad fork from
     TensorFleet/kicad's rolling `nightly` release (`scripts/stage-kicad-bundle.ts --require`), and
     package the app with electron-builder: macOS arm64 and x64 (`.dmg`, `.zip`), Linux x64
     (`.AppImage`, `.deb`), Windows x64 (`.exe` installer). `after-pack` copies the staged tree to
     `Resources/kicad/`.
   - The `release` job collects the installers, runs `scripts/release-manifest.ts` to compute
     SHA-256 for every file and write `manifest.json` + `SHA256SUMS`, tags the commit
     `v<version>`, and creates a GitHub Release with everything attached.
   - `workflow_dispatch` with `channel=internal` builds with the private router bundled; internal
     builds are uploaded only as workflow artifacts and never released.
2. **Automatic website handoff**: after the public GitHub release succeeds, the
   `website` job dispatches `TensorFleet/fabplane.com`'s `desktop-release.yml` with
   the new tag, **waits for that run to finish**, and fails if the live feed
   `https://fabplane.com/desktop/latest.json` is not the new version. That
   workflow checks installer hashes, uploads installers and the feed to the
   public R2 downloads bucket, commits the website feed and history, dispatches
   `deploy-public.yml` for production, and verifies the live site. The website
   also retries daily at 23:17 UTC if a handoff or deployment failed; that retry
   **fails** (instead of skip-succeeding) when FabDesk left newer unpublished
   drafts. A failed handoff can be rerun without rebuilding the installers.
   - Configure `FABPLANE_RELEASE_DISPATCH_TOKEN` here: a fine-grained token with
     **Actions read and write** on **only `TensorFleet/fabplane.com`**. Write is
     required to dispatch; read is required to poll the run (`gh run view`, not
     `gh run watch` — watch needs `checks:read`, which fine-grained PATs cannot
     grant). The website needs its separate `FABDESK_RELEASE_READ_TOKEN` with
     **Contents read** on this repo.
   - The public feed is the committed file
     `apps/web/public/desktop/latest.json` on fabplane.com, served by
     `deploy-public.yml`. R2 (`downloads.fabplane.com`) hosts the installers and,
     after publish, a copy of `desktop/latest.json` for the download page.
   - Nightlies never reach this job unless every build can download
     `fabPlane/fab_pcb` tag `backend-<vendor/fab_pcb sha10>`. A missing backend
     release fails the build with that tag name; do not treat a green
     `desktop-release.yml` skip as a refreshed feed.
   - Merge the website workflow and configure both credentials before enabling
     this handoff. See fabplane.com's `docs/desktop-releases.md`.
   - Merges to `main` no longer cut releases. Manual public dispatches on `main`
     publish just like the nightly; internal builds remain workflow artifacts only.
3. **Release notes**: the `version` job runs `scripts/release-notes.ts` once. If entries were added
   to the repo-root `release-notes.json` since the previous `v*` tag, those hand-written New /
   Improved / Fixed bullets are the notes; otherwise they are the commit subjects since that tag.
   The JSON is baked into every installer (`FABDESK_RELEASE_NOTES_FILE` →
   `electron.vite.config.ts`) for the app's "What's new" dialog, and its Markdown rendering is
   `manifest.json` `notes`, which fabplane.com shows on `/download#v<version>`. One generation,
   so the app and the site always match. To write notes by hand, add an entry with a new unique
   `id` to `release-notes.json`; it applies to the next release only.
4. **In-app update check**: `@fabdesk/updates` fetches `https://fabplane.com/desktop/latest.json`
   at startup and every 6 hours (`FABDESK_UPDATE_URL` overrides), compares semver with the running
   version and shows the update badge. Nothing downloads until the user clicks it.
5. **In-place update** (`apps/desktop/src/main/update-install.ts`): clicking the badge downloads
   the update with electron-updater, checks it against the manifest's SHA-256, and the badge
   becomes **Restart to update**. That click stops the core and the bridges, replaces the app and
   relaunches it: Squirrel.Mac from the `.zip` on macOS (never the DMG), the NSIS installer run
   silently on Windows, a file swap for the AppImage.
   - The feed is still `latest.json`: a custom electron-updater provider reads it, so no
     `latest-mac.yml` / `latest.yml` is hosted and the website publishes nothing new. The
     `publish` entry in `electron-builder.yml` only makes the build write `app-update.yml`
     (cache folder name, Windows publisher); `latest*.yml` and `.blockmap` files that
     electron-builder leaves in `release/` are not released. Downloads are full size, since no
     blockmaps are hosted.
   - macOS needs the signed, notarized build: Squirrel.Mac refuses an update whose signature does
     not match the running app.
   - The old flow (download the installer to Downloads, then open it) remains for a `.deb`
     install, an app run from the mounted DMG or a translocated path, `FABDESK_UPDATE_INPLACE=0`,
     for the rest of the session after two failed in-place attempts, and for a version whose
     in-place install was started but did not apply (`update-install.json` in the user data
     folder records the started version; the next launch compares it with the running one).

TraceMaker weekly binaries reuse the same public host under `tracemaker/`
(`https://downloads.fabplane.com/tracemaker/…`). See [routers.md](routers.md). The desktop
`website` job is unchanged.

## `manifest.json` / `latest.json` contract

Schema: `packages/protocol/src/releases.ts` (`ReleaseManifest`, `LatestRelease`). Field names are
shared with the website and must not be renamed.

```json
{
  "schema": 1,
  "version": "0.1.42",
  "tag": "v0.1.42",
  "channel": "public",
  "commit": "<sha>",
  "publishedAt": "2026-09-02T12:00:00.000Z",
  "releaseUrl": "https://github.com/TensorFleet/fabdesk/releases/tag/v0.1.42",
  "assets": [
    {
      "filename": "fabPlane-0.1.42-mac-arm64.dmg",
      "platform": "darwin",
      "arch": "arm64",
      "kind": "dmg",
      "url": "https://downloads.fabplane.com/desktop/v0.1.42/fabPlane-0.1.42-mac-arm64.dmg",
      "sha256": "<hex>",
      "size": 123456789
    }
  ]
}
```

`platform` ∈ `darwin | linux | win32`, `arch` ∈ `arm64 | x64`, `kind` ∈
`dmg | zip | AppImage | deb | exe | portable`. Before the first release the website serves
`{ "schema": 1, "version": null, "assets": [] }`. Releases through 0.1.x used `Fabdesk-` artifact
prefixes; current builds use `fabPlane-`. `classify()` accepts both. The electron-builder `appId`
stays `com.tensorfleet.fabdesk` so Windows shortcuts, the AppUserModelId, and NSIS upgrade
identity do not reset; in-app updates fetch this feed by URL and do not use `appId`.

## Secrets

| Secret | Purpose |
|---|---|
| `FABDESK_SUBMODULE_SSH_KEY` | Read-only deploy key for the private `TensorFleet/fabplane.com` submodule. The fabPlane organization disables deploy keys, so this secret must not be used for `fabPlane/fab_pcb`. |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS Developer ID certificate (base64 .p12) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate |
| `FAB_PCB_RELEASE_TOKEN` | Fine-grained contents-read token for private `fabPlane/fab_pcb`. Workflows use it to check out the exact submodule commit and desktop builds download tag `backend-<vendor/fab_pcb commit prefix>`, refusing an unpinned/latest bundle. A missing token or missing tag fails the build before packaging. |
| `FABPLANE_RELEASE_DISPATCH_TOKEN` | Fine-grained token with **Actions read+write** on **only `TensorFleet/fabplane.com`**. The `website` job uses it to dispatch `desktop-release.yml`, poll that run with `gh run view`, and fail if the public feed does not update. |

Without signing secrets the workflow still produces unsigned installers.

The fab_pcb release must contain `fp-pcb-backend-<target>.tar.gz` for `linux-x64`,
`darwin-x64`, `darwin-arm64`, and `windows-x64`, each with `bundle.json` at the archive root.
Those artifacts must be built and smoke-tested on their native runners; cross-compilation alone is
not release proof. Missing credentials, tag, target, or manifest fails the FabPlane release before
electron-builder runs.

## Verifying a download

```bash
shasum -a 256 fabPlane-0.1.42-mac-arm64.dmg   # macOS / Linux
certutil -hashfile fabPlane-0.1.42-win-x64.exe SHA256   # Windows
```

## Installer checks

- Every release run verifies its own installers on the runner (`scripts/verify-installers.ts`:
  `hdiutil verify`, mount, `codesign`, the bundled core runs; `unzip -t`, AppImage extract, `dpkg-deb`,
  `7z t`) and the release job compares the transferred artifacts against per-runner checksums before
  tagging. A build that fails either step is not released.
- Public installer workflow artifacts are retained for one day because the permanent GitHub
  Release receives the same files immediately. Internal-build artifacts are retained for seven days.
- For the user-facing path (download, Gatekeeper / SmartScreen, first launch) run the fresh-VM tests
  in [installer-vms.md](installer-vms.md): `bun run vm:mac test`, `vm:linux`, `vm:windows`.
