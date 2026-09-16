# FabPlane KiCad bundle staging

Release builds pull the rolling **`nightly`** GitHub Release from
[`TensorFleet/kicad`](https://github.com/TensorFleet/kicad) (override with `FABDESK_KICAD_REPO` /
`FABDESK_KICAD_RELEASE`). That workflow publishes:

| Platform | Rolling asset |
|---|---|
| Linux x86_64 | `kicad-cli-linux-x86_64.tar.gz` |
| macOS arm64 | `kicad-cli-macos-arm64.tar.gz` |
| macOS x86_64 | `kicad-cli-macos-x86_64.tar.gz` |
| Windows x86_64 | `kicad-cli-windows-x86_64.zip` |

plus `manifest.json` (preferred) and `SHA256SUMS`.

```bash
bun run scripts/stage-kicad-bundle.ts --target bun-darwin-arm64 --require
```

The stage script reads `manifest.json` first, then falls back to release assets by name. Do **not**
use `/releases/latest` — `nightly` is a prerelease.

Overrides:

```bash
FABDESK_KICAD_BUNDLE_URL='https://…/kicad-cli-{nightlyPlatform}.tar.gz' \
  bun run scripts/stage-kicad-bundle.ts --target bun-darwin-arm64

bun run scripts/stage-kicad-bundle.ts --from /path/to/unpacked-kicad-cli --target bun-darwin-arm64
```

Expected layout after staging (nightly archive with top-level `kicad-cli/` flattened):

| Platform | Path to CLI |
|---|---|
| Linux / macOS | `kicad-cli` |
| Windows | `bin/kicad-cli.exe` |

`after-pack` copies this tree into the installer as `Resources/kicad/`.
