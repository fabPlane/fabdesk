# Optional native CAD runtime

PR245 now removes the always-bundled engine. The normal desktop contains no CAD runtime and
must start its PCB/core features without CAD, without network access, and with an invalid CAD
cache. Stock FreeCAD GUI is not an API-capable runtime. Packaged builds ignore development
source/mock overrides. Cached installations and `/Applications/CADRuntime.app` are accepted
only after exact native API/bridge pins, signed paths, Developer ID identity, stapled ticket
and Gatekeeper verification.

The CAD tab fetches small metadata on first use and asks permission with version, platform,
minimum OS and exact download/unpacked byte counts. The Download action opens a native consent
dialog; Later is the default. A decline persists across restarts and leaves a manual Download
action. No engine download happens during application startup, metadata preparation, or Later.
A download already in progress is shared by repeated clicks; Cancel aborts it and cleans partial
files. The cache is `<userData>/cad-runtimes/`, outside the application bundle.

Runtime integrity uses SHA-256 and exact byte counts, safe ZIP preflight, signed native resources,
Apple trust anchor and Developer ID team CMNZZ92926 (the existing desktop publisher), stapled
notarization, and `spctl` assessment. Quarantine is assigned and preserved, never removed.
Extraction rejects traversal, absolute paths, escaping links, files through symlink aliases,
case collisions, special files, incompatible ZIP formats, excessive size, and inconsistent
local/central paths. The verified directory is renamed atomically. An incompatible previous
cache is preserved separately when replacing it; interrupted work is cleaned on restart only
when its lock-owning process is gone. Existing good installs are reused offline. Runtime changes
restart the desktop's owned core to deliver the authenticated bridge configuration.

## Exact public source and publication boundary

`fabPlane/FreeCAD` is an existing **public** repository, anonymously accessible. `TensorFleet/fabdesk`
is private and is not the download source. No repository visibility or permissions were changed.
The prepared release is `https://github.com/fabPlane/FreeCAD/releases/tag/cad-runtime-v1-9bcf850-65c72d6`:

- `cad-runtime-darwin-arm64.zip`: Developer ID signed, notarized/stapled runtime container app.
- `manifest-darwin-arm64.json`: exact compressed/unpacked sizes and ZIP SHA-256; exact source pins
  and URLs for the runtime, `cad-runtime-sources.tar.gz`, and `NOTICE.txt`.
- `cad-runtime-sources.tar.gz`: all corresponding FreeCAD/dependency sources, exact build recipe,
  patches and license notices. Sources/notices also remain inside the signed runtime itself.
- `NOTICE.txt`: license summary, with complete notices in the runtime/source archive.

FreeCAD API source: `fabPlane/FreeCAD@9bcf850de03c79e12c1e8bedd550ae2265b624f0`.
Bridge/viewer source: `fabPlane/fab_cad@65c72d69e59c503ad1d23790448a954d5fc283b7`.
Only macOS ARM64 on macOS 15+ is supported initially. Other targets display an unsupported
message, retain PCB features, and never download a different architecture or a mock.

The runtime release **does not exist yet**. First-use metadata reports this explicitly.
`.github/workflows/cad-runtime.yml` prepares signed assets with the desktop's existing Apple
secrets and runner setup. It uploads private review artifacts only, with no public write token
and no public-publishing job. The build-only activation is [draft PR248](https://github.com/TensorFleet/fabdesk/pull/248),
which changes only the workflow. It checks out immutable reviewed source `dda10c3`, uses the
existing release submodule access and Apple secrets, has read-only contents permission, runs
only on manual main dispatch, and accepts no caller-selected source or publication input.
It must be reviewed/landed independently to become dispatchable; PR245 remains draft. Then
run `gh workflow run cad-runtime.yml --repo TensorFleet/fabdesk --ref main` and review its
private signed artifacts and final sizes before the separately approved public publication.
Neither workflow nor public publication has been executed. Signing/notarization of
this optional container remains unverified. Do not merge/publish the former bundled approach.

After signed workflow artifacts are reviewed and the user approves public publication, an
already-authorized maintainer can run `bun scripts/publish-cad-runtime.ts <artifact-directory>
--approved-public-release=cad-runtime-v1-9bcf850-65c72d6` on a Mac. This explicitly guarded step
checks public repository identity, signed archive, checksum, exact source/license asset references
and refuses to overwrite an existing tag. No new credentials or services are required.

## Build and private measurement

Use official existing LLVM22, CMake, Ninja, Python3.12, Qt6 qtbase/qttools, OCCT, Boost,
ICU78, Xerces-C, Eigen, yaml-cpp and TBB. The scripts install nothing globally:

```sh
python3 scripts/build-freecad-macos.py --source /tmp/cad-source --build /tmp/cad-build --install /tmp/cad-install
python3 scripts/prepare-freecad-macos.py --install /tmp/cad-install --source /tmp/cad-source --python-home /opt/homebrew/opt/python@3.12/Frameworks/Python.framework/Versions/3.12 --output /tmp/cad-runtime --source-cache /tmp/cad-sources
FABDESK_FREECAD_RUNTIME=/tmp/cad-runtime bun run cad:stage --target bun-darwin-arm64
bun run cad:smoke dist/cad/darwin-arm64/bundle.json
bun scripts/package-cad-runtime.ts dist/cad/darwin-arm64 /tmp/cad-artifacts --unsigned-candidate
```

The engine recipe preserves the GUI-only SWIG guard, embedded-Python isolation corrections,
OCCT/TBB linkage and official source/license receipt collection validated in the native API smoke.
It never uses installed user FreeCAD preferences; the final native smoke uses disposable preferences.
`cad:stage` builds the pinned web/bridge in a disposable checkout without installing into vendor.

The unsigned measurement candidate is **560,546,330 bytes compressed** and **756,923,316 bytes
unpacked** (535 MiB / 722 MiB). This includes source/license material and dependencies; it is not
FreeCAD alone. The source-only release archive is about 427 MiB. The final signed ZIP must be
remeasured; production metadata is emitted only after signing/notarization. Unsigned candidates
have distinct filenames and cannot be accepted by the installer or public-publishing script.

## Validation and remaining checks

Automated tests cover consent, decline/restart, valid installed cache, incompatible engine,
unsupported target/OS, offline and unpublished releases, errors, checksum/signature rejection,
cancel, explicit retry, concurrent clicks, dead-lock cleanup and unsafe archives. The earlier
real packaged API smoke proves native FCStd save/reopen and STEP export. Desktop UI previously
loaded real FreeCAD; edit/export UI verification remains pending. The parent owns foreground UI;
this change does not launch an app or interfere with stable-release QA.

End-to-end public installation, genuine container Developer ID signing/notarization, final signed
sizes, and foreground consent/edit/save/reopen/STEP testing remain blocked on the signed artifact
build and approved publication. Unit tests use injected signature/transport fixtures and are not
proof that a public runtime has been installed.
