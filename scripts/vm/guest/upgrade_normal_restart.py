"""Packaged acceptance checks for FabDesk's visible update control and normal app lifecycle."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid


def core_request(bridge, method, path, data=None):
    daemon = bridge.daemon()
    request = urllib.request.Request(
        f"http://127.0.0.1:{daemon['port']}{path}", data=data, method=method,
        headers={"authorization": "Bearer " + daemon["token"], "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read()


def save_test_project(bridge):
    project = json.loads(core_request(bridge, "POST", "/projects", b'{"name":"Upgrade continuity"}'))
    path = "/projects/" + urllib.parse.quote(project["id"], safe="") + "/files/NOTES.md"
    contents = f"Saved after clicking Update: {uuid.uuid4()}\n".encode()
    core_request(bridge, "PUT", path, contents)
    return path, contents


def verify_saved_project(bridge, project):
    path, contents = project
    if core_request(bridge, "GET", path) != contents:
        raise RuntimeError("Saved project contents changed across the update")


def screenshot(bridge, path):
    bridge.screenshot(str(path))
    if not path.is_file() or path.stat().st_size < 1000:
        raise RuntimeError(f"Missing window screenshot: {path.name}")


def mac_window_lifecycle(bridge, exe, old_pid, step):
    mounted = os.environ.get("FABDESK_TEST_MOUNTED_APP")
    if mounted:
        # Trying to launch the disk image while the installed app is running must
        # leave the existing workspace and pending upgrade in the same process.
        subprocess.run(["open", "-n", "-a", mounted], check=True, timeout=30)
        time.sleep(3)
        if bridge.pid() != old_pid or bridge.call("GET", "/state")["app"]["pid"] != old_pid:
            raise RuntimeError("Opening the mounted copy displaced the installed app")
        step("opening a second copy from the DMG preserved the running installed workspace")

    bridge.eval("setTimeout(() => window.close(), 0); true")
    until = time.monotonic() + 30
    while bridge.call("GET", "/state")["windows"]:
        if time.monotonic() >= until:
            raise RuntimeError("Closing the Mac window did not dismiss it")
        time.sleep(0.5)
    if bridge.pid() != old_pid:
        raise RuntimeError("Closing the last Mac window unexpectedly quit")
    subprocess.run(["open", "-a", str(exe.parents[2])], check=True, timeout=30)
    while time.monotonic() < until:
        try:
            if bridge.pid() == old_pid and bridge.eval("Boolean(document.querySelector('[data-ready=true]'))"):
                step("closing and reopening the Mac window retained the staged update without quitting")
                return
        except (RuntimeError, OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Reopening the Mac window did not restore the staged update")


def click_update(bridge, version, out):
    # Center-point hit testing catches a clipped or covered button at the user's click location.
    label = f"Update to {version}"
    if os.environ.get("FABDESK_TEST_MOVE") == "1":
        label = "Move to Applications"
    elif os.environ.get("FABDESK_TEST_DEB_NAME"):
        label = "Update with package manager"
    selector = f'[aria-label="FabDesk update"] button[aria-label="{label}"]'
    probe = """(() => {
      const button = document.querySelector(SELECTOR);
      if (!button || button.disabled) return false;
      const r = button.getBoundingClientRect(), x = r.left + r.width/2, y = r.top + r.height/2;
      return r.width > 0 && r.height > 0 && button.contains(document.elementFromPoint(x,y));
    })()""".replace("SELECTOR", json.dumps(selector))
    until = time.monotonic() + 40
    while not bridge.eval(probe):
        if time.monotonic() >= until:
            screenshot(bridge, out / "upgrade-missing-button.png")
            raise RuntimeError(f"No visible, clickable Update to {version} button")
        time.sleep(0.5)
    # The first capture of a newly shown Mac window can return the compositor's
    # previous startup frame even after DOM hit testing succeeds. Wake capturePage
    # before waiting for a fresh paint, and confirm the same control is still visible.
    if sys.platform == "darwin":
        bridge.call("POST", "/screenshot", {"format": "png", "scale": 0.25})
        bridge.eval("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
        time.sleep(1)
        if not bridge.eval(probe):
            raise RuntimeError("Update control moved or disappeared before the screenshot")
    screenshot(bridge, out / "upgrade-offered.png")
    bridge.call("POST", "/click", {"selector": selector})


def disk_updated(exe, version, state):
    if sys.platform == "darwin":
        with (exe.parents[1] / "Info.plist").open("rb") as handle:
            return plistlib.load(handle)["CFBundleShortVersionString"] == version
    if os.name == "nt":
        # Windows PE versions have a fourth, build-specific component (e.g. 0.4.26.0).
        # The release manifest and the running desktop/core use major.minor.patch.
        ps = ("$v = (Get-Item -LiteralPath $env:FABDESK_TEST_INSTALLED_EXE -ErrorAction Stop).VersionInfo; "
              "($v.ProductMajorPart, $v.ProductMinorPart, $v.ProductBuildPart) -join '.'")
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                                env={**os.environ, "FABDESK_TEST_INSTALLED_EXE": str(exe)},
                                capture_output=True, text=True, timeout=20)
        return result.returncode == 0 and result.stdout.strip() == version
    if state["filename"].lower().endswith(".deb"):
        result = subprocess.run(["dpkg-query", "-W", "-f=${Version}", os.environ["FABDESK_TEST_DEB_NAME"]], capture_output=True, text=True)
        return result.returncode == 0 and result.stdout.strip() == version
    digest = hashlib.sha256()
    with exe.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == state["sha256"]


def normal_restart(bridge, installed_path, version, state, old_pid, deadline, step, out):
    exe = Path(installed_path)
    ready = bridge.eval("document.querySelector('[aria-label=\"FabDesk update\"]')?.innerText")
    if not ready or "ready for next launch" not in ready.lower():
        raise RuntimeError(f"Staged state missing from the main window: {ready!r}")
    if bridge.pid() != old_pid:
        raise RuntimeError("Clicking Update restarted the app before the user quit")
    screenshot(bridge, out / "upgrade-ready.png")
    def windows_snapshot():
        diagnostic = Path(__file__).with_name("windows-upgrade-state.ps1")
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(diagnostic),
                                 str(exe), state["path"], str(bridge.user_data)],
                                capture_output=True, text=True, timeout=15)
        step(f"Windows update: bridge pid={bridge.pid()}, old pid={old_pid}, {result.stdout.strip()}")

    if os.name == "nt":
        windows_snapshot()
    if sys.platform == "darwin":
        mac_window_lifecycle(bridge, exe, old_pid, step)
        subprocess.run(["/usr/bin/swift", str(Path(__file__).with_name("quit-mac-app.swift")),
                        str(old_pid), str(exe.parents[2])], check=True, timeout=90)
    else:
        # Closing the last application window follows the installed app's normal Quit path.
        try:
            bridge.eval("setTimeout(() => window.close(), 0); true")
        except OSError:
            pass
    step("quit normally with no Install or Restart button click")
    next_snapshot = time.monotonic()
    while time.time() < deadline:
        if sys.platform == "darwin" and time.monotonic() >= next_snapshot:
            try:
                with (exe.parents[1] / "Info.plist").open("rb") as info:
                    installed = plistlib.load(info)["CFBundleShortVersionString"]
            except (OSError, plistlib.InvalidFileException):
                installed = "being replaced"
            processes = subprocess.run(["ps", "-p", str(old_pid), "-o", "pid=,stat=,comm="],
                                       capture_output=True, text=True).stdout.strip() or "exited"
            step(f"Mac quit check: source={processes}, bridge PID={bridge.pid()}, installed={installed}")
            next_snapshot = time.monotonic() + 30
        if os.name == "nt" and time.monotonic() >= next_snapshot:
            windows_snapshot()
            next_snapshot = time.monotonic() + 30
        if not bridge.pid():
            try:
                if disk_updated(exe, version, state):
                    break
            except (OSError, ValueError):
                pass  # A native installer may be replacing this file.
        elif bridge.pid() != old_pid:
            raise RuntimeError("FabDesk reopened itself following a normal Quit")
        time.sleep(1)
    else:
        raise RuntimeError("The update did not reach the original install path following Quit")
    time.sleep(4)
    if bridge.pid():
        raise RuntimeError("FabDesk relaunched without user initiation")
    if sys.platform == "darwin":
        command = ["open", "-a", str(exe.parents[2])]
    elif os.name == "nt":
        command = [str(exe)]
    else:
        command = [str(exe), "--disable-gpu", "--disable-dev-shm-usage"]
    with (out / "second-launch.log").open("wb") as log:
        subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    step("reopened the same installed application")
