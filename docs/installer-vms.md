# Installer test VMs

## On Blacksmith runners (the default)

`.github/workflows/installer-test.yml` runs the same guest scripts directly on Blacksmith's macOS,
Ubuntu and Windows runners, which are fresh VMs per job: no image to prepare or host to keep.
It runs after every successful Release (testing that tag), weekly against what fabplane.com
serves, and on demand (`gh workflow run installer-test.yml -f tag=v0.1.42`). Each job uploads
`report.json`, `app.png`, `screen.png` and logs as a seven-day artifact, and fails when the guest
reports a failure. The macOS x64 build is exercised under Rosetta on the arm64 runner.

## Daily job on agent1 (OpenClaw)

`scripts/vm/install-agent.sh agent1` copies `scripts/vm` to `/home/openclaw/fabdesk-vm` on agent1
(a Proxmox VM with nested KVM) and declares the OpenClaw automation `fabdesk-installer-vm-daily-v1`:
`daily.sh` runs the Linux AppImage, Linux deb and Windows NSIS fresh-VM tests against whatever
fabplane.com serves, every day at 05:00 Asia/Bangkok, announcing to the TensorFleet Telegram
destination only when something fails. Base images live under `/home/openclaw/.fabdesk-vm`
(prepared once with `linux.sh prepare` and `windows.sh prepare --guest x86_64` as user openclaw).
`daily.sh` sizes each VM from the host's available memory (4 GiB Linux, 6 GiB Windows by default,
always leaving 3 GiB for the host) and runs them one at a time; a full run takes about five
minutes under KVM. Re-run `install-agent.sh` after changing the scripts.

## Local VMs (debugging)


`scripts/vm/` boots a **fresh** virtual machine per run, installs a Fabdesk build the way a user
would, launches it with the automation bridge on, checks the core daemon, takes screenshots and
writes a report. Nothing is reused between tests except the base image, so first-run problems
(corrupt DMG, Gatekeeper, missing FUSE, SmartScreen, missing runtime libraries) show up here
instead of on a user's machine.

| Host | macOS guest | Linux guest | Windows guest |
|---|---|---|---|
| Apple Silicon Mac | Tart (Virtualization.framework), arm64 + x64-via-Rosetta | QEMU x86_64 under TCG (slow, ~10 min) | QEMU x86_64 Windows 11 under TCG (default; install 1-3 h, test ~15 min) or `--guest aarch64` under HVF with Windows' x64 emulation |
| Intel Mac / Linux | not supported | QEMU with HVF/KVM (fast) | QEMU with an x64 ISO |

```bash
bun run vm:mac prepare              # pulls ghcr.io/cirruslabs/macos-sequoia-base (~25 GB, once)
bun run vm:linux prepare            # Ubuntu 22.04 cloud image + cloud-init, once
bun run vm:windows prepare                       # downloads the Windows 11 Enterprise eval ISO (x64), unattended install, once
bun run vm:windows prepare --guest aarch64       # fast arm64 guest instead (installer runs under Windows' x64 emulation)

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
launches `fabPlane.app/Contents/MacOS/fabPlane` with `FABDESK_AUTOMATION=1 FABDESK_UPDATE_CHECK=0`,
waits for `daemon.json` + `app-bridge.json` in `~/Library/Application Support/fabPlane`, calls
`/health`, grabs a screenshot through the bridge, then `screencapture`.

**Linux** (`guest/linux-test.sh`): AppImage (needs FUSE, which the base image has) or
`apt install ./fabPlane.deb`, runs the core, launches `fabplane` under Xvfb, same daemon / bridge checks,
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
- Windows `prepare` performs a full unattended install with TPM / Secure Boot checks bypassed and
  creates user `fabdesk`/`fabdesk` (auto-logon). Without `--iso` it downloads Microsoft's 90-day
  Windows 11 Enterprise evaluation ISO for the guest arch (a direct link, no form). With your own
  retail ISO set `FABDESK_VM_WIN_IMAGE_INDEX` if the Pro image is not index 6. The install runs once;
  every test boots a qcow2 overlay of that disk. Only inbox drivers are used (NVMe, e1000e / RNDIS,
  standard VGA), so no virtio ISO is needed.
- The default x86_64 Windows guest is what users run and executes the x64 installer natively, but on
  Apple Silicon it is emulated: plan for a one-time install of one to three hours.
- `--keep` leaves the VM running after a test: `vm:mac shell`, `vm:linux shell`, or
  `vm:windows console` to look around. `destroy` removes base images and clones.
- Runner-side checks (`scripts/verify-installers.ts`) still run in CI on every release; the VMs are
  for the user-facing path the runners cannot exercise.
