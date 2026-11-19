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

## Component models

Bundling the KiCad runtime does not imply bundling its stock 3D library. On 2026-11-19,
the public **v0.3.190 Windows x64 installer** (SHA-256
`8f18a973d82dcd4374eb346e13981750bcbf361c87350f2864b1d8de92a929b4`) and the
**macOS arm64 ZIP** archive index both contained KiCad runtimes but **no `3dmodels`
tree or STEP/WRL model files**. The Windows archive did contain 15,415 footprints
and 223 symbol-library files. These are separate from component geometry.
Artifacts: [public release feed](https://fabplane.com/desktop/latest.json) and
[v0.3.190 release](https://github.com/TensorFleet/fabdesk/releases/tag/v0.3.190).

Model discovery reuses existing libraries in place: explicit model overrides,
the backend's declared stock-data root, bundled KiCad/PCB-backend trees, the selected
CLI's installation, then known standalone installs. Prefix, macOS `SharedSupport`,
and nested nightly layouts are supported. No model downloads or duplicate copies
are added. Custom project paths and transforms remain unchanged; unavailable exact
models remain missing. A fresh machine without model assets still needs a library
or project-provided models.
