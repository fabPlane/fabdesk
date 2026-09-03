# Installer test VMs

`scripts/vm/` boots a **fresh** virtual machine per run, installs a Fabdesk build the way a user
would, launches it with the automation bridge on, checks the core daemon, takes screenshots and
writes a report. Nothing is reused between tests except the base image, so first-run problems
(corrupt DMG, Gatekeeper, missing FUSE, SmartScreen, missing runtime libraries) show up here
instead of on a user's machine.

| Host | macOS guest | Linux guest | Windows guest |
|---|---|---|---|
| Apple Silicon Mac | Tart (Virtualization.framework), arm64 + x64-via-Rosetta | QEMU x86_64 under TCG (slow, ~10 min) | QEMU Windows 11 arm64 under HVF; x64 installer runs under Windows' x64 emulation |
| Intel Mac / Linux | not supported | QEMU with HVF/KVM (fast) | QEMU with an x64 ISO |

```bash
bun run vm:mac prepare              # pulls ghcr.io/cirruslabs/macos-sequoia-base (~25 GB, once)
bun run vm:linux prepare            # Ubuntu 22.04 cloud image + cloud-init, once
bun run vm:windows prepare --iso ~/Downloads/Win11_24H2_Arm64.iso   # unattended install, once

bun run vm:mac test                                # newest DMG in apps/desktop/release/
bun run vm:mac test --arch x64 --format zip
bun run vm:linux test --format deb --tag v0.1.40   # GitHub release asset
bun run vm:windows test --latest                   # whatever fabplane.com serves right now
```

Installer selection for `test`: `--file <path>`, `--tag vX.Y.Z` (downloaded with `gh` into
`~/.fabdesk-vm/cache/`), `--latest` (version from `https://fabplane.com/desktop/latest.json`),
or by default the newest matching file in `apps/desktop/release/`.

Each run ends with a summary and a folder under `~/.fabdesk-vm/results/<os>-<stamp>/`:

- `report.json` with `ok`, install details, Gatekeeper / Authenticode verdict, `fabdesk-core version`,
  the `/health` response, and launch time.
- `app.png` (window capture through the automation bridge) and `screen.png` (whole guest display,
  which also shows OS dialogs such as "Apple could not verify" or SmartScreen).
- `log.txt`, the app's stdout, and the app log files from its config dir.

The exit status is non-zero when the guest reports a failure, so the scripts work in CI as well.

## What each guest test does

**macOS** (`guest/mac-test.sh`): quarantines the installer like a browser download, `hdiutil verify`
+ mount (DMG) or `ditto` (zip), copies to `/Applications`, records `spctl` (Gatekeeper),
`codesign --verify --deep --strict` and stapler status, removes quarantine, runs the bundled core,
launches `Fabdesk.app/Contents/MacOS/Fabdesk` with `FABDESK_AUTOMATION=1 FABDESK_UPDATE_CHECK=0`,
waits for `daemon.json` + `app-bridge.json` in `~/Library/Application Support/Fabdesk`, calls
`/health`, grabs a screenshot through the bridge, then `screencapture`.

**Linux** (`guest/linux-test.sh`): AppImage (needs FUSE, which the base image has) or
`apt install ./Fabdesk.deb`, runs the core, launches under Xvfb, same daemon / bridge checks,
`import -window root` for the display.

**Windows** (`guest/windows-test.ps1`): marks the installer as downloaded (Zone.Identifier),
records the Authenticode signature, silent NSIS install (`/S`) or the portable exe, launches with
the bridge on, same checks, GDI screen capture. Results are uploaded to the host over HTTP
(`scripts/vm/receiver.py` on the QEMU user-network gateway) because the guest has no ssh.

## Notes and limits

- Tart needs a Mac with Apple Silicon and macOS 13+. `prepare` installs it via Homebrew if missing.
  The base image auto-logs in as `admin`/`admin`; the scripts use `SSH_ASKPASS`, no sshpass.
- The Linux build is x86_64 only, so on Apple Silicon the guest runs emulated. Use `--timeout` to
  extend the default 900 s if the host is busy.
- Windows `prepare` performs a full unattended install from Microsoft's ISO with TPM / Secure Boot
  checks bypassed and creates user `fabdesk`/`fabdesk` (auto-logon). Set `FABDESK_VM_WIN_IMAGE_INDEX`
  if your ISO's Pro image is not index 6 (`wimlib-imagex info` lists them). The install runs once;
  every test boots a qcow2 overlay of that disk.
- `--keep` leaves the VM running after a test: `vm:mac shell`, `vm:linux shell`, or
  `vm:windows console` to look around. `destroy` removes base images and clones.
- Runner-side checks (`scripts/verify-installers.ts`) still run in CI on every release; the VMs are
  for the user-facing path the runners cannot exercise.
