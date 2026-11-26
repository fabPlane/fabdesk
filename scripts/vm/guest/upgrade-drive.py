#!/usr/bin/env python3
"""Drives an in-place update of a running fabPlane through the app automation bridge.

The caller installs an older release and launches it with FABDESK_AUTOMATION=1 and the update
check left on. This script then does what a user does: waits for the "Update X" badge, clicks it,
waits for "Restart to update", clicks that, and checks that the app comes back on the new version.
Same script on macOS, Linux and Windows (standard library only).

  upgrade-drive.py --user-data <dir> --out <dir> [--feed URL] [--timeout seconds]

Writes <out>/upgrade-report.json and exits 0 only when the running app reports the feed's version.
"""
import argparse
import base64
import json
import os
import re
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

    def badge(self):
        """The update badge as (text, selector), or None while it is not shown."""
        for query in ("Update", "Restart to update", "Downloading", "Verifying", "Restarting", "Install"):
            found = self.call("GET", "/find?" + urllib.parse.urlencode({"query": query, "limit": 5}))
            for match in found.get("matches", []):
                text = (match.get("text") or "").strip()
                if len(text) < 40 and re.match(r"^(Update \d+\.\d+\.\d+$|Restart to update$|Downloading|Verifying|Restarting|Install \d+\.\d+\.\d+$|Update failed)", text):
                    return text, match.get("ref")
        return None

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

    clicked_update = clicked_restart = False
    last = None
    while time.time() < deadline:
        try:
            badge = bridge.badge()
        except (RuntimeError, urllib.error.URLError, OSError, ValueError):
            badge = None
            if clicked_restart:
                break  # the app went away to install
        text = badge[0] if badge else None
        if text != last:
            step(f"badge: {text}")
            last = text
        if badge and text.startswith("Update failed"):
            bridge.screenshot(os.path.join(args.out, "upgrade-failed.png"))
            finish(f"the badge reports a failed update ({text})")
        if badge and text.startswith("Install "):
            bridge.screenshot(os.path.join(args.out, "upgrade-fallback.png"))
            finish("the app fell back to the installer file instead of updating in place")
        if badge and text.startswith("Update ") and not clicked_update:
            if text != f"Update {target}":
                finish(f"the badge offers '{text}', expected 'Update {target}'")
            bridge.call("POST", "/click", {"selector": badge[1]})
            clicked_update = True
            step("clicked the update badge")
        elif badge and text == "Restart to update" and not clicked_restart:
            bridge.screenshot(os.path.join(args.out, "upgrade-ready.png"))
            bridge.call("POST", "/click", {"selector": badge[1]})
            clicked_restart = True
            step("clicked Restart to update")
        time.sleep(2)
    if not clicked_restart:
        finish("timed out before Restart to update appeared" if clicked_update else "the update badge never appeared")

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
