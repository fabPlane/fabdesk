"""Capture the isolated FabDesk window while it runs, including after it relaunches."""
import base64
import hashlib
import json
import time
import sys
import urllib.parse
import urllib.request
from pathlib import Path

work = Path(sys.argv[1])
profile = Path(sys.argv[2])
work.mkdir(parents=True, exist_ok=True)
frames = work / "live-window"
frames.mkdir(exist_ok=True)
plain = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_state(value):
    pending = work / "recorder-state.tmp"
    pending.write_text(json.dumps(value), encoding="utf8")
    pending.replace(work / "recorder-state.json")


def call(url, token, endpoint, data=None):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Expected isolated loopback bridge")
    req = urllib.request.Request(url.rstrip("/") + endpoint,
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers={"authorization": "Bearer " + token, "content-type": "application/json"})
    with plain.open(req, timeout=2) as response:
        return json.load(response)


def capture():
    previous = None
    versions = {}
    counter = 0
    last_output = 0
    last_frame = None
    gap = False
    atomic_state({"status": "waiting", "frames": 0})
    with (work / "real-window-frames.jsonl").open("w", encoding="utf8", buffering=1) as timeline:
        while not (work / "stop-recording").exists():
            start = time.monotonic()
            try:
                bridge = read_json(profile / "app-bridge.json")
                daemon = read_json(profile / "daemon.json")
                pid = bridge["pid"]
                shot = call(bridge["url"], daemon["token"], "/screenshot", {"format": "jpeg"})
                captured = time.time()
                if pid not in versions:
                    try:
                        versions[pid] = call(bridge["url"], daemon["token"], "/state")["app"]["version"]
                    except (OSError, ValueError, KeyError):
                        pass
                raw = base64.b64decode(shot["base64"], validate=True)
                if not raw.startswith(b"\xff\xd8") or min(shot["width"], shot["height"]) < 160:
                    raise ValueError("Empty app window")
                digest = hashlib.sha256(raw).hexdigest()
                relative = "live-window/" + digest + ".jpg"
                if digest != previous:
                    target = work / relative
                    if not target.exists():
                        target.write_bytes(raw)
                previous = digest
                counter += 1
                row = {"time": captured, "pid": pid, "file": relative,
                       "app": versions.get(pid), "core": daemon.get("version"),
                       "width": shot["width"], "height": shot["height"]}
                timeline.write(json.dumps(row) + "\n")
                if not counter % 5 or counter == 1 or gap:
                    atomic_state({"status": "recording", "frames": counter, **row})
                gap = False
                last_frame = captured
            except (OSError, KeyError, ValueError, TypeError):
                if last_frame and time.time() - last_frame > 0.75 and not gap:
                    gap = True
                    timeline.write(json.dumps({"time": time.time(), "unavailable": True}) + "\n")
                if time.monotonic() - last_output > 2:
                    atomic_state({"status": "window unavailable" if counter else "waiting",
                                  "frames": counter, "last_frame": last_frame})
                    last_output = time.monotonic()
            time.sleep(max(0.01, 0.17 - (time.monotonic() - start)))
    atomic_state({"status": "stopped", "frames": counter, "last_frame": last_frame})


if __name__ == "__main__":
    capture()
