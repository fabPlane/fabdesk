"""Open the unmodified incoming FabDesk package during a real silent NSIS extraction."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import time
import uuid


def main(installer, out):
    if os.name != "nt" or os.getenv("GITHUB_ACTIONS") != "true" or os.getenv("RUNNER_ENVIRONMENT") != "github-hosted":
        raise RuntimeError("This test requires a disposable GitHub-hosted Windows runner")
    temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    if not all(path.resolve().is_relative_to(temp) for path in (installer, out)):
        raise RuntimeError("The candidate and results must be in the disposable runner's temp directory")
    exe = Path(os.environ["LOCALAPPDATA"]) / "Programs/fabPlane/fabplane.exe"
    profile = Path(os.environ["APPDATA"]) / "fabPlane"
    if exe.parent.exists() or profile.exists():
        raise RuntimeError("The incoming package requires an empty user profile and a fresh installation")
    version = re.fullmatch(r"fabplane-(\d+\.\d+\.\d+)-win-x64\.exe", installer.name).group(1)
    guid = str(uuid.uuid5(uuid.UUID("50e065bc-3134-11e6-9bab-38c9862bdaf3"), "com.tensorfleet.fabdesk"))
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenMutexW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.OpenMutexW.restype = wintypes.HANDLE
    kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)

    def mutex_active():
        handle = kernel.OpenMutexW(0x00100000, False, guid)  # SYNCHRONIZE
        if not handle:
            if ctypes.get_last_error() == 2:
                return False
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(handle)
        return True

    def extracted(path):
        # A path may exist with its final length while its extracting writer still owns the handle.
        handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0, None)  # read, share read, open existing
        if handle == wintypes.HANDLE(-1).value:
            return False
        kernel.CloseHandle(handle)
        return True

    bridge = runpy.run_path(str(Path(__file__).with_name("upgrade-drive.py")))["Bridge"](str(profile))
    report = {"ok": False, "mode": "real NSIS extraction", "version": version, "installed": str(exe), "steps": []}
    start = time.monotonic()

    def step(text):
        message = f"{time.monotonic() - start:.1f}s {text}"
        print(message, flush=True)
        report["steps"].append(message)

    try:
        profile.mkdir()
        with installer.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        (profile / "update-install.json").write_text(json.dumps({"phase": "applying", "version": version, "sha256": digest}))
        if mutex_active():
            raise RuntimeError("Another installer was already active")
        install = subprocess.Popen([str(installer), "--updated", "/S"])  # no --force-run, only the test opens FabDesk
        symbols = exe.parent / "resources/pcb/libraries/symbols"
        runtime = (exe, exe.parent / "resources/app.asar", exe.parent / "resources.pak",
                   exe.parent / "v8_context_snapshot.bin", exe.parent / "icudtl.dat")
        deadline = start + 600
        while time.monotonic() < deadline and install.poll() is None:
            if mutex_active() and not symbols.exists() and all(extracted(path) for path in runtime):
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("No real extraction window with a readable app and missing PCB symbols was observed")
        step("NSIS held the FabDesk installer mutex, the EXE and app.asar were readable, and PCB symbols were absent")
        stdout, stderr = out / "native-stdout.txt", out / "native-stderr.txt"
        launch_arg = f"--fabdesk-qa-early-launch={uuid.uuid4()}"
        with stdout.open("wb") as output, stderr.open("wb") as errors:
            early = subprocess.Popen([str(exe), "--updated", launch_arg], stdout=output, stderr=errors)
        step(f"opened the original installed path during extraction (PID {early.pid})")
        deferred = False
        while mutex_active() and time.monotonic() < deadline:
            if bridge.pid() or bridge.daemon():
                raise RuntimeError("FabDesk started a desktop bridge or core while NSIS still owned the installation")
            if not deferred and early.poll() is not None:
                if early.returncode != 0:
                    raise RuntimeError(f"The early launch exited with {early.returncode}")
                marker = b"Waiting for the Windows installer before opening FabDesk"
                if not any(marker in log.read_bytes() for log in (stdout, stderr)):
                    raise RuntimeError("The early process exited without acknowledging the active Windows installer")
                deferred = True
                step("early launch deferred and exited cleanly while NSIS was still working")
            time.sleep(0.2)
        if not deferred or mutex_active() or install.wait(timeout=30) != 0 or not symbols.is_dir():
            raise RuntimeError("The actual NSIS installer did not finish cleanly after the deferred launch")
        step("the native installer exited, released its mutex, and provided the bundled symbols")
        ready_deadline = time.monotonic() + 120
        while time.monotonic() < ready_deadline:
            if bridge.pid() and bridge.daemon():
                try:
                    if bridge.call("GET", "/state")["app"]["version"] == version and bridge.daemon()["version"] == version:
                        break
                except (OSError, ValueError, RuntimeError):
                    pass
            time.sleep(0.5)
        else:
            raise RuntimeError("The single early open did not produce a ready desktop and core after installation")
        new_pid = bridge.pid()
        # Count only Electron main processes for this installation, excluding Chromium children.
        ps = ('$p = Get-CimInstance Win32_Process -Filter "Name=\'fabplane.exe\'" | '
              'Where-Object { $_.ExecutablePath -eq $env:FABDESK_TEST_INSTALLED_EXE -and $_.CommandLine -notmatch " --type=" }; '
              '$p | ForEach-Object { if ($_.CommandLine.Contains($env:FABDESK_TEST_LAUNCH_ARG) -and '
              '$_.CommandLine.Contains("--updated")) { $_.ProcessId } else { "unexpected:$($_.ProcessId)" } }')
        pids = subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                                       env={**os.environ, "FABDESK_TEST_INSTALLED_EXE": str(exe),
                                            "FABDESK_TEST_LAUNCH_ARG": launch_arg}, text=True).split()
        if pids != [str(new_pid)] or new_pid == early.pid:
            raise RuntimeError(f"Expected one new main process for the original EXE; got {pids}")
        image = out / "incoming-launch-ready.png"
        bridge.screenshot(str(image))
        if not image.is_file() or image.stat().st_size == 0:
            raise RuntimeError("The recovered window did not provide a screenshot")
        step(f"one recovered main process (PID {new_pid}) and core both report {version}; captured its window")
        report["ok"] = True
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (out / "incoming-launch-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("installer", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    main(args.installer, args.out)
