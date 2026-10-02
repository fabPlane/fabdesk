# Packaged native CAD

The desktop contains the pinned fabPlane FreeCAD application core, its API server, Part,
Sketcher, PartDesign, Mesh and Import modules, Python 3.12, OCCT and all non-system dynamic
libraries. It is a native headless engine, independent of any installed FreeCAD application.
The browser CAD viewer connects through the bundled authenticated bridge. WASM is optional
and is not included in this first native package.

Production startup requires `Resources/cad/bundle.json` with `engine: "native"`. A missing
engine is a startup error. `FABDESK_FAB_CAD_SOURCE` and its development mock are ignored by
packaged apps. An explicitly configured `FABDESK_FAB_CAD_BUNDLE` can replace the native bundle.
The existing per-launch bridge token, upstream session key, origin restrictions and local-only
CAD tools remain in force.

## Build on macOS ARM64

Use the existing official Homebrew dependencies: LLVM 22, CMake, Ninja, Python 3.12, Qt6
qtbase/qttools, OCCT, Boost, ICU 78, Xerces-C, Eigen, yaml-cpp and TBB. The scripts install
nothing globally. The source revision comes from `vendor/fab_cad/packages/protocol/FREECAD_COMMIT`.
Use new temporary directories for all outputs:

```sh
python3 scripts/build-freecad-macos.py \
  --source /tmp/cad-source --build /tmp/cad-build --install /tmp/cad-install
python3 scripts/prepare-freecad-macos.py \
  --install /tmp/cad-install --source /tmp/cad-source \
  --python-home /opt/homebrew/opt/python@3.12/Frameworks/Python.framework/Versions/3.12 \
  --output /tmp/cad-runtime --source-cache /tmp/cad-source-cache
bun run cad:stage --from /tmp/cad-runtime --target bun-darwin-arm64
bun run cad:smoke dist/cad/darwin-arm64/bundle.json
```

For a yaml-cpp built into a temporary prefix, add `--extra-prefix` to the build command and
`--library-search-dir PREFIX/lib --yaml-source SOURCE` to runtime preparation. Only its
official source and license are accepted. The build carries a small GUI-only SWIG guard fix
in the corresponding FreeCAD source archive, plus an explicit embedded-Python configuration
patch to honor bundled Python home, disable user site-packages and prevent bytecode writes.
The fork uses an isolated Python configuration which otherwise ignores these environment
controls. The build also explicitly links the installed OCCT TBB
dependency and avoids SDK include-order problems with Homebrew LLVM.

`cad:stage` builds the exact submodule in a disposable checkout, installs its locked workspace
dependencies there, compiles the bridge and builds the production viewer without source maps.
It rejects a runtime with the wrong architecture or FreeCAD protocol revision. `afterPack`
requires and copies that bundle for the target. Installer verification runs the same native
smoke test on a matching host; foreign-architecture execution requires a native runner.

The smoke test uses disposable project data and explicit FreeCAD preferences. It requires real
FreeCAD modules, an FCStd ZIP, a successful close/session restart/reopen, and an OCCT STEP
`ISO-10303-21` payload. It also verifies unauthenticated health is 401 and cross-origin health
is 403. Mock JSON documents and mock export behavior cannot pass.

## Signing and redistribution

Runtime preparation copies the complete native-library closure, rewrites load commands to
bundle-relative paths, removes external loader paths and excludes the external Python
site-packages link. Embedded Python bytecode writes are disabled so native CAD execution
does not change the app seal. Installer validation rechecks the signature after the smoke. Every copied Mach-O is ad-hoc signed for local execution. The existing
electron-builder signing pipeline subsequently signs enclosed binaries/frameworks and the
app with Developer ID when configured, including the compiled bridge and API executable.
Local directory builds use the existing ad-hoc app-signing hook. Release credentials and
notarization settings are not created or changed by this work. Developer ID signing and
stapled notarization still need release-runner verification.

FreeCAD is LGPL-2.1-or-later. OCCT uses LGPL-2.1 with its additional exception. The selected Qt
essential libraries use LGPL-3.0. Other dependency notices are collected from their exact
official source archives. `freecad/licenses` includes the notices and prominent summary;
`freecad/sources` includes the patched FreeCAD source, exact dependency source archives,
checksum manifest, installed build formulae/receipts, dependency patches and these build
scripts. Download checksums must match the installed official formula. A checksum mismatch
or unavailable source fails preparation. No separate commercial license or EULA acceptance
is needed for this open-source build.

Keep the dynamic engine replaceable. Users may rebuild the included sources, prepare/stage
their own bundle and select it through `FABDESK_FAB_CAD_BUNDLE`. A locally changed copied
binary can be ad-hoc signed with `codesign --force --sign - PATH`; the existing app pipeline
can re-sign a changed app. Do not impose terms prohibiting library replacement or debugging
such changes. Review the exact bundled notices before publishing; source archives must ship
with the release artifact rather than depending on rolling download links.

Official references: [FreeCAD license](https://github.com/FreeCAD/FreeCAD/blob/main/LICENSE),
[Qt LGPL obligations](https://www.qt.io/development/open-source-lgpl-obligations),
[OCCT license](https://github.com/Open-Cascade-SAS/OCCT/blob/master/LICENSE_LGPL_21.txt).

## Platform status

| Target | Status |
| --- | --- |
| macOS ARM64 | Native build and relocated FCStd/STEP/authentication smoke validated on this Mac |
| macOS x64 | Build recipe/runtime not validated; requires its own native runner |
| Linux x64 | Requires an equivalent native runtime and dependency-closure build |
| Windows x64 | Requires its own API-server build, Python/native DLL assets and signing smoke |

The release workflow builds the macOS ARM64 runtime. Other matrix targets fail explicitly
without a supplied matching native runtime; they cannot silently ship the mock or omit CAD.
Published immutable fork artifacts for the other targets and their native smoke results
remain required before the complete release matrix can pass.
