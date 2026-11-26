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
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FEED = "https://fabplane.com/desktop/latest.json"


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
    parser.add_argument("--feed", default=FEED)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    report = {"ok": False, "from": None, "to": None, "target": None, "steps": [], "error": None}
    started = time.time()
    deadline = started + args.timeout

    def step(message):
        line = f"{int(time.time() - started):4d}s {message}"
        print(line, flush=True)
        report["steps"].append(line)

    def finish(error=None):
        report["error"] = error
        report["ok"] = error is None
        report["seconds"] = int(time.time() - started)
        with open(os.path.join(args.out, "upgrade-report.json"), "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(("PASS" if error is None else f"FAIL: {error}"), flush=True)
        sys.exit(0 if error is None else 1)

    # The site's CDN refuses Python's default user agent.
    feed = urllib.request.Request(args.feed, headers={"user-agent": "fabplane-upgrade-test", "accept": "application/json"})
    with urllib.request.urlopen(feed, timeout=30) as response:
        target = json.loads(response.read().decode())["version"]
    report["target"] = target
    bridge = Bridge(args.user_data)

    while time.time() < deadline and not (bridge.daemon() and os.path.exists(os.path.join(args.user_data, "app-bridge.json"))):
        time.sleep(1)
    daemon = bridge.daemon()
    if not daemon:
        finish("the old version never started (no daemon.json)")
    report["from"] = daemon.get("version")
    old_pid = daemon.get("pid")
    step(f"running {report['from']} (core pid {old_pid}); feed offers {target}")
    if report["from"] == target:
        finish(f"the installed version is already {target}; nothing to update from")

    # The app checks the feed a few seconds after start; ask again until it has an answer.
    status = None
    while time.time() < deadline:
        try:
            status = bridge.eval("window.fabdesk.updateStatus()") or bridge.eval("window.fabdesk.checkForUpdates()")
        except (RuntimeError, urllib.error.URLError, OSError, ValueError):
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

    # Not awaited: the call resolves when the download ends, far past the bridge's eval limit.
    bridge.eval("void window.fabdesk.downloadUpdate(), null")
    step("started the download (what clicking the badge does)")
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
    report["downloaded"] = state.get("filename")
    if not state.get("restart"):
        finish(f"the app fell back to the installer file ({state.get('filename')}) instead of updating in place")
    bridge.screenshot(os.path.join(args.out, "upgrade-ready.png"))
    bridge.eval("void window.fabdesk.openUpdate(), null")
    step("asked the app to restart into the update (what clicking Restart to update does)")
    # A failed install comes back as an error state while the old app is still up.
    for _ in range(10):
        try:
            state = bridge.eval("window.fabdesk.updateDownloadState()") or {}
        except (RuntimeError, urllib.error.URLError, OSError, ValueError):
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
            step(f"app is back on {report['to']} (core pid {daemon.get('pid')})")
            time.sleep(5)
            try:
                bridge.screenshot(os.path.join(args.out, "upgrade-after.png"))
            except RuntimeError:
                pass
            finish(None if report["to"] == target else f"the app came back on {report['to']}, expected {target}")
        time.sleep(2)
    finish("the app did not come back after Restart to update")


if __name__ == "__main__":
    main()
