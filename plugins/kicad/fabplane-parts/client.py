"""Talk to the local fabPlane daemon. No wx / pcbnew imports — unit tests use this module."""

from __future__ import annotations

import json
import os
import posixpath
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping

STRINGS = {
    "title": "fabPlane parts",
    "signed_in": "signed in",
    "sign_in": "Sign in via the fabPlane app, then reopen this plugin.",
    "daemon_missing": "fabPlane is not running. Start the app so daemon.json is written, then retry.",
    "type_query": "Type a part number, value, or footprint.",
    "empty_hits": "No matches in my libraries, the team library, or KiCad.",
    "empty_prompt": "No matches. Enter a part number or datasheet URL and click Make this part.",
    "make_placeholder": "Part number or datasheet URL",
    "make_button": "Make this part",
    "copy_button": "Copy to clipboard",
    "clipboard_title": "KiCad schematic clipboard (paste with Ctrl+V / Cmd+V)",
    "clipboard_hint": "Self-contained: no library files are copied onto the project.",
    "columns": ("Source", "Symbol", "Footprint", "Value", "MPN", "Manufacturer"),
}

PRODUCT_DIRS = ("fabPlane Dev", "fabPlane")
CORE_HOME_DIRS = ("fabdesk-dev", "fabdesk")


def _join(platform: str, *parts: str) -> str:
    if platform == "win32":
        return "\\".join(parts)
    return posixpath.join(*parts)


def config_root(env: Mapping[str, str], home: str, platform: str) -> str:
    if platform == "darwin":
        return _join(platform, home, "Library", "Application Support")
    if platform == "win32":
        appdata = env.get("APPDATA") or _join(platform, home, "AppData", "Roaming")
        return appdata
    xdg = env.get("XDG_CONFIG_HOME") or _join(platform, home, ".config")
    return xdg


def daemon_json_candidates(
    env: Mapping[str, str] | None = None,
    *,
    home: str | None = None,
    platform: str | None = None,
) -> list[str]:
    env = env or os.environ
    if platform not in ("win32", "darwin", "linux"):
        hinted = platform or sys.platform or os.name
        if hinted in ("nt", "win32", "win"):
            platform = "win32"
        elif hinted.startswith("darwin") or hinted == "mac":
            platform = "darwin"
        else:
            platform = "linux"
    home = home or env.get("HOME") or os.path.expanduser("~")
    out: list[str] = []
    seen: set[str] = set()

    def add(path: str | None) -> None:
        if not path:
            return
        path = os.path.expanduser(path)
        if path in seen:
            return
        seen.add(path)
        out.append(path)

    add(env.get("FABPLANE_DAEMON_JSON"))
    add(env.get("FABDESK_DAEMON_JSON"))
    fabdesk_home = env.get("FABDESK_HOME")
    if fabdesk_home:
        add(_join(platform, fabdesk_home, "daemon.json"))
    root = config_root(env, home, platform)
    for name in PRODUCT_DIRS:
        add(_join(platform, root, name, "daemon.json"))
    for name in CORE_HOME_DIRS:
        add(_join(platform, root, name, "daemon.json"))
    return out


def find_daemon_json(
    env: Mapping[str, str] | None = None,
    *,
    home: str | None = None,
    platform: str | None = None,
    exists=os.path.isfile,
) -> str | None:
    for path in daemon_json_candidates(env, home=home, platform=platform):
        if exists(path):
            return path
    return None


def load_handshake(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not data.get("token") or not data.get("port"):
        raise ValueError(f"invalid daemon handshake: {path}")
    return data


def make_body(text: str) -> dict[str, str]:
    value = text.strip()
    if not value:
        raise ValueError("mpn or datasheetUrl is required")
    if "://" in value:
        return {"datasheetUrl": value}
    return {"mpn": value}


class DaemonError(Exception):
    def __init__(self, status: int, payload: Any, message: str | None = None):
        self.status = status
        self.payload = payload
        super().__init__(message or (payload.get("message") if isinstance(payload, dict) else str(payload)))

    @property
    def code(self) -> str:
        if isinstance(self.payload, dict) and isinstance(self.payload.get("error"), str):
            return self.payload["error"]
        return "daemon_error"


class PartsPickerClient:
    def __init__(self, handshake: Mapping[str, Any], opener=None):
        host = handshake.get("host") or "127.0.0.1"
        self.base = f"http://{host}:{handshake['port']}"
        self.token = str(handshake["token"])
        self._opener = opener

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {self.token}",
                "accept": "application/json",
                **({"content-type": "application/json"} if body is not None else {}),
            },
        )
        try:
            if self._opener is not None:
                response = self._opener.open(req, timeout=20)
            else:
                response = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"message": raw}
            raise DaemonError(error.code, payload) from error
        with response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}

    def status(self) -> dict[str, Any]:
        return self._request("GET", "/parts-picker")

    def search(self, query: str, limit: int = 40) -> dict[str, Any]:
        qs = urllib.parse.urlencode({"q": query, "limit": str(limit)})
        return self._request("GET", f"/parts-picker/search?{qs}")

    def paste(self, hit: Mapping[str, Any]) -> dict[str, Any]:
        body = {
            "id": hit.get("id"),
            "source": hit.get("source"),
            "symbol": hit.get("symbol"),
            "footprint": hit.get("footprint") or "",
            "value": hit.get("value") or "",
            **({"mpn": hit["mpn"]} if hit.get("mpn") else {}),
            **({"manufacturer": hit["manufacturer"]} if hit.get("manufacturer") else {}),
        }
        return self._request("POST", "/parts-picker/paste", body)

    def make(self, text: str) -> dict[str, Any]:
        return self._request("POST", "/parts-picker/make", make_body(text))


def connect(env: Mapping[str, str] | None = None) -> PartsPickerClient:
    path = find_daemon_json(env)
    if not path:
        raise FileNotFoundError(STRINGS["daemon_missing"])
    return PartsPickerClient(load_handshake(path))
