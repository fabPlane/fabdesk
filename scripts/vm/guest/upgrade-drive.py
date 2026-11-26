#!/usr/bin/env python3
"""Drives an in-place update of a running fabPlane through the app automation bridge.

The caller installs an older release and launches it with FABDESK_AUTOMATION=1 and the update
check left on. A fresh profile sits at the sign-in screen, where the update badge is not drawn, so
this script makes the calls the badge makes (`window.fabdesk.downloadUpdate()` and `openUpdate()`,
the preload API behind "Update X" and "Restart to update") and follows the same download state
the badge shows, then checks that the app comes back on the new version.
Same script on macOS, Linux and Windows (standard library only).

  upgrade-drive.py --user-data <dir> --out <dir> [--feed URL] [--timeout seconds]

Writes <out>/upgrade-report.json and exits 0 only when the running app reports the feed's version.
"""
import argparse
import base64
import http.client
import json
import os
import sys
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from upgrade_normal_restart import click_update, click_update_button, core_request, save_test_project, normal_restart, verify_saved_project

FEED = "https://fabplane.com/desktop/latest.json"
# What a bridge call raises when the app is not there (yet, or any more).
GONE = (RuntimeError, urllib.error.URLError, http.client.HTTPException, OSError, ValueError)


def read_json(path):
    try:
        with open(path, encoding="utf-8-sig") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


class Bridge:
    """The automation bridge of whichever app instance currently owns the user-data folder."""

    def __init__(self, user_data):
        self.user_data = user_data

    def daemon(self):
        return read_json(os.path.join(self.user_data, "daemon.json"))

    def call(self, method, path, body=None, timeout=30):
        daemon = self.daemon()
        bridge = read_json(os.path.join(self.user_data, "app-bridge.json"))
        if not daemon or not bridge:
            raise RuntimeError("app is not running (no daemon.json / app-bridge.json)")
        request = urllib.request.Request(
            bridge["url"] + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={"authorization": "Bearer " + daemon["token"], "content-type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())

    def pid(self):
        """Process id of the app that wrote the current bridge file, or None."""
        return (read_json(os.path.join(self.user_data, "app-bridge.json")) or {}).get("pid")

    def eval(self, code):
        """Runs `code` in the renderer (the bridge awaits it for up to 10 s) and returns its value."""
        return self.call("POST", "/eval", {"code": code}).get("result")

    def screenshot(self, path):
        try:
            shot = self.call("POST", "/screenshot", {"format": "png"})
            with open(path, "wb") as handle:
                handle.write(base64.b64decode(shot["base64"]))
        except Exception as error:  # a screenshot is evidence, never the reason a run fails
            print(f"screenshot failed: {error}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--feed", default=os.environ.get("FABDESK_UPDATE_URL", FEED))
    parser.add_argument("--executable", help="Original installed path to reopen after ordinary Quit")
    parser.add_argument("--one-click", action="store_true", help="Require the visible Update button and normal restart")
    parser.add_argument("--restart-now", action="store_true", help="Click Restart now and require the same profile to reopen itself")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    if args.restart_now and not args.one_click:
        parser.error("--restart-now requires --one-click")
    os.makedirs(args.out, exist_ok=True)
    report = {"ok": False, "from": None, "to": None, "target": None, "steps": [], "error": None}
    started = time.time()
    deadline = started + args.timeout
    deb_auth = None

    def step(message):
        line = f"{int(time.time() - started):4d}s {message}"
        print(line, flush=True)
        report["steps"].append(line)

    def finish(error=None):
        if deb_auth is not None and deb_auth.poll() is None:
            deb_auth.terminate()
            deb_auth.wait(timeout=10)
        report["error"] = error
        report["ok"] = error is None
        report["seconds"] = int(time.time() - started)
        with open(os.path.join(args.out, "upgrade-report.json"), "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(("PASS" if error is None else f"FAIL: {error}"), flush=True)
        sys.exit(0 if error is None else 1)

    def verify_signed_out(phase):
        if os.environ.get("FABDESK_TEST_SIGNED_OUT") != "1":
            return
        try:
            status = json.loads(core_request(bridge, "GET", "/v1/auth/state")).get("status")
        except GONE as error:
            finish(f"Could not check sign-in state {phase} the update: {type(error).__name__}")
        if status != "signed_out":
            finish(f"Expected a signed-out profile {phase} the update")
        step(f"confirmed signed-out profile {phase} the update")

    # The site's CDN refuses Python's default user agent.
    feed = urllib.request.Request(args.feed, headers={"user-agent": "fabplane-upgrade-test", "accept": "application/json"})
    with urllib.request.urlopen(feed, timeout=30) as response:
        target = json.loads(response.read().decode())["version"]
    report["target"] = target
    # After a Release the workflow names the version it just published: a feed still serving the
    # older one would otherwise only show up as a confusing "nothing to update from".
    expected = os.environ.get("FABDESK_UPGRADE_EXPECT", "").lstrip("v")
    if expected and expected != target:
        finish(f"the feed serves {target}, but the release under test is {expected}")
    bridge = Bridge(args.user_data)

    while time.time() < deadline and not (bridge.daemon() and os.path.exists(os.path.join(args.user_data, "app-bridge.json"))):
        time.sleep(1)
    daemon = bridge.daemon()
    if not daemon:
        finish("the old version never started (no daemon.json)")
    report["from"] = daemon.get("version")
    old_pid = daemon.get("pid")
    old_bridge_pid = bridge.pid()
    step(f"running {report['from']} (core pid {old_pid}); feed offers {target}")
    if report["from"] == target:
        finish(f"the installed version is already {target}; nothing to update from")

    # The candidate must discover the offer automatically. Observe its normal startup
    # check without forcing it on behalf of a user who has not opened Settings.
    status = None
    while time.time() < deadline:
        try:
            status = bridge.eval("window.fabdesk.updateStatus()")
            if not args.one_click and not status:
                status = bridge.eval("window.fabdesk.checkForUpdates()")
        except GONE:
            status = None
        if status and status.get("latest"):
            break
        time.sleep(3)
    if not status or not status.get("latest"):
        finish(f"the app never got an answer from the update feed ({(status or {}).get('error')})")
    offered = status["latest"].get("version")
    step(f"app sees {offered}, updateAvailable={status.get('updateAvailable')}")
    if not status.get("updateAvailable") or offered != target:
        finish(f"the app offers {offered} (updateAvailable={status.get('updateAvailable')}), expected {target}")
    verify_signed_out("before")

    # Keep testing the historical download/restart contract for older published versions.
    # Candidate tests require the real control; they cannot fall back to a preload call.
    one_click = args.one_click or (args.executable and bridge.eval(
        "Boolean(document.querySelector('[aria-label=\"FabDesk update\"] button[aria-label^=\"Update to\"]'))"))
    project = None
    if one_click:
        if not args.executable:
            finish("one-click test requires the original installed executable")
        try:
            test_move = os.environ.get("FABDESK_TEST_MOVE") == "1"
            if test_move:
                core_request(bridge, "PATCH", "/settings", b'{"keepCoreRunning":true}')
                if not json.loads(core_request(bridge, "GET", "/settings")).get("keepCoreRunning"):
                    finish("Could not enable the persistent core on the mounted copy")
            if os.environ.get("FABDESK_TEST_DEB_NAME"):
                agent_ready = Path(args.out) / "polkit-ready"
                deb_auth = subprocess.Popen(["/usr/bin/python3", str(Path(__file__).with_name("deb-ci-auth.py")),
                                             str(old_bridge_pid), str(agent_ready)])
                until = time.monotonic() + 25
                while not agent_ready.exists() and deb_auth.poll() is None and time.monotonic() < until:
                    time.sleep(0.1)
                if not agent_ready.exists() or deb_auth.poll() is not None:
                    finish("Polkit could not register an authentication agent; the update was never clicked")
                step("Polkit registered an interactive authentication agent for the desktop process")
            click_update(bridge, target, Path(args.out))
            if test_move:
                # macOS relaunches the installed copy as part of first-time relocation.
                # The accepted update must resume there without another click.
                move_deadline = min(deadline, time.time() + 120)
                while time.time() < move_deadline:
                    try:
                        if (bridge.pid() and bridge.pid() != old_bridge_pid and
                            bridge.call("GET", "/state")["app"]["version"] == report["from"]):
                            break
                    except GONE:
                        pass
                    time.sleep(1)
                else:
                    finish("Move to Applications did not open the installed copy")
                if not Path(args.executable).is_file():
                    finish("The relocated app is missing from Applications")
                if bridge.daemon()["pid"] == old_pid:
                    finish("The relocated app reused the core running from the disk image")
                try:
                    os.kill(old_pid, 0)
                except ProcessLookupError:
                    pass
                else:
                    finish("The mounted copy left its original core process running")
                if not json.loads(core_request(bridge, "GET", "/settings")).get("keepCoreRunning"):
                    finish("Moving to Applications changed the user's persistent-core setting")
                old_pid, old_bridge_pid = bridge.daemon()["pid"], bridge.pid()
                step("the mounted copy released its persistent core and resumed the update in Applications")
            project = save_test_project(bridge)
        except Exception as error:
            finish(f"visible update or project save failed: {error}")
        step("clicked the visible Update control once and saved a project using the running core")
    else:
        bridge.eval("void window.fabdesk.downloadUpdate(), null")
        step("started the legacy download")
    last = None
    state = {}
    while time.time() < deadline:
        state = bridge.eval("window.fabdesk.updateDownloadState()") or {}
        name = state.get("state")
        if name != last:
            step(f"download state: {name}")
            last = name
        if name == "error":
            bridge.screenshot(os.path.join(args.out, "upgrade-failed.png"))
            finish(f"the update failed: {state.get('message')}")
        if name == "done":
            break
        time.sleep(2)
    if state.get("state") != "done":
        finish("timed out while downloading the update")
    if one_click and os.environ.get("FABDESK_TEST_DEB_NAME") and deb_auth.wait(timeout=20) != 0:
        finish("the test did not complete normal Debian package-manager authorization")
    report["downloaded"] = state.get("filename")
    if not state.get("restart"):
        finish(f"the app fell back to the installer file ({state.get('filename')}) instead of updating in place")
    bridge.screenshot(os.path.join(args.out, "upgrade-ready.png"))
    if one_click:
        try:
            if args.restart_now:
                click_update_button(bridge, "Restart now", Path(args.out), "upgrade-restart.png")
                step("clicked Restart now; waiting for automatic relaunch in the original profile")
            else:
                normal_restart(bridge, args.executable, target, state, old_bridge_pid, deadline, step, Path(args.out))
        except Exception as error:
            finish(f"update restart failed: {error}")
    else:
        try:
            bridge.eval("void window.fabdesk.openUpdate(), null")
        except GONE:
            pass  # Windows and the AppImage quit before the bridge can answer
        step("asked the legacy updater to restart")
    # A failed install comes back as an error state while the old app is still up.
    for _ in range(0 if one_click else 10):
        try:
            state = bridge.eval("window.fabdesk.updateDownloadState()") or {}
        except GONE:
            break  # the app went away to install
        if state.get("state") == "error":
            finish(f"the install failed: {state.get('message')}")
        time.sleep(2)

    step("waiting for the app to come back")
    while time.time() < deadline:
        daemon = bridge.daemon()
        if daemon and daemon.get("pid") != old_pid:
            report["to"] = daemon.get("version")
            try:
                health = urllib.request.Request(
                    f"http://127.0.0.1:{daemon['port']}/health", headers={"authorization": "Bearer " + daemon["token"]}
                )
                with urllib.request.urlopen(health, timeout=10) as response:
                    json.loads(response.read().decode())
            except (urllib.error.URLError, OSError, ValueError, KeyError):
                time.sleep(2)
                continue
            step(f"core is back on {report['to']} (core pid {daemon.get('pid')})")
            if report["to"] != target:
                finish(f"the app came back on {report['to']}, expected {target}")
            # A core alone is not the app: the new window must answer through a new bridge too.
            # The launch scripts put FABDESK_AUTOMATION where the relaunched app inherits it.
            window_deadline = min(deadline, time.time() + 180)
            while time.time() < window_deadline:
                try:
                    if bridge.pid() != old_bridge_pid and bridge.eval("document.readyState") == "complete":
                        if one_click:
                            app_version = bridge.call("GET", "/state")["app"]["version"]
                            if app_version != target:
                                finish(f"desktop reports {app_version}; expected {target}")
                            verify_saved_project(bridge, project)
                            verify_signed_out("after")
                            step(f"desktop and core are both {target}; saved project recovered")
                        step(f"window is back (app pid {bridge.pid()})")
                        bridge.screenshot(os.path.join(args.out, "upgrade-after.png"))
                        finish(None)
                except GONE:
                    pass
                time.sleep(2)
            finish(f"the core came back on {target} but the app window never answered through the automation bridge")
        time.sleep(2)
    finish("the app did not come back after Restart to update")


if __name__ == "__main__":
    main()
