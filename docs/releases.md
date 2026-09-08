# Releases and updates

## Pipeline

1. **Merge to `main`** → `.github/workflows/release.yml` runs.
   - Version is `<major>.<minor>.<run_number>` where `<major>.<minor>` comes from the root
     `package.json` (bump that to start a new minor line). `scripts/set-version.ts` stamps it
     into the app manifests before building.
   - Four runners build `fabdesk-core` for their own target and package the app with
     electron-builder: macOS arm64 and x64 (`.dmg`, `.zip`), Linux x64 (`.AppImage`, `.deb`),
     Windows x64 (`.exe` installer + portable).
   - The `release` job collects the installers, runs `scripts/release-manifest.ts` to compute
     SHA-256 for every file and write `manifest.json` + `SHA256SUMS`, tags the commit
     `v<version>`, and creates a GitHub Release with everything attached.
   - `workflow_dispatch` with `channel=internal` builds with the private router bundled; internal
     builds are uploaded only as workflow artifacts and never released.
2. **Website publish** (fabplane.com): `bun run desktop:publish --tag v<version>` downloads the
   release with `gh`, verifies the hashes, optionally re-hosts the installers on R2, and writes
   `apps/web/public/desktop/latest.json`, `releases.json` and `SHA256SUMS-<tag>.txt`. Committing
   and deploying the site publishes the download buttons, `/download`, and the update feed.
3. **In-app update check**: `@fabdesk/updates` fetches `https://fabplane.com/desktop/latest.json`
   at startup and every 6 hours (`FABDESK_UPDATE_URL` overrides), compares semver with the running
   version and points the user at the right installer. It never downloads or installs on its own.

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
| `FABDESK_SUBMODULE_SSH_KEY` | Read-only deploy keys for the private submodules (fabplane.com; fab_pcb if it is private) concatenated; loaded by `webfactory/ssh-agent`, which routes each private submodule fetch through its own key. Rotate by regenerating both keys (`ssh-keygen -t ed25519 -C git@github.com:TensorFleet/<repo>`), re-adding them with `gh repo deploy-key add`, and re-setting the secret. |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | macOS Developer ID certificate (base64 .p12) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate |

Without signing secrets the workflow still produces unsigned installers.

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
- For the user-facing path (download, Gatekeeper / SmartScreen, first launch) run the fresh-VM tests
  in [installer-vms.md](installer-vms.md): `bun run vm:mac test`, `vm:linux`, `vm:windows`.
