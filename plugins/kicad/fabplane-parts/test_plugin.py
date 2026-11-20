#!/usr/bin/env python3
"""Unit tests for the in-KiCad parts picker. Must not import pcbnew or wx."""

from __future__ import annotations

import ast
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import client  # noqa: E402


def _parse(name: str) -> ast.AST:
    return ast.parse((HERE / name).read_text(encoding="utf-8"), filename=name)


class ForbiddenImportFinder(ast.NodeVisitor):
    def __init__(self) -> None:
        self.found: list[str] = []

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name.split(".")[0] in {"pcbnew", "wx"}:
                self.found.append(alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        root = (node.module or "").split(".")[0]
        if root in {"pcbnew", "wx"}:
            self.found.append(node.module or "")
        self.generic_visit(node)


class ClientTests(unittest.TestCase):
    def test_test_module_does_not_import_pcbnew_or_wx(self) -> None:
        self.assertNotIn("pcbnew", sys.modules)
        self.assertNotIn("wx", sys.modules)

    def test_client_source_has_no_kicad_gui_imports(self) -> None:
        tree = _parse("client.py")
        finder = ForbiddenImportFinder()
        finder.visit(tree)
        self.assertEqual(finder.found, [])

    def test_plugin_source_is_valid_python(self) -> None:
        for name in ("plugin.py", "__init__.py", "client.py"):
            _parse(name)

    def test_ui_strings_match_the_panel(self) -> None:
        self.assertEqual(client.STRINGS["title"], "fabPlane parts")
        self.assertEqual(client.STRINGS["empty_hits"], "No matches in my libraries, the team library, or KiCad.")
        self.assertEqual(
            client.STRINGS["empty_prompt"],
            "No matches. Enter a part number or datasheet URL and click Make this part.",
        )
        self.assertEqual(client.STRINGS["make_button"], "Make this part")
        self.assertEqual(client.STRINGS["copy_button"], "Copy to clipboard")
        self.assertEqual(client.STRINGS["columns"], ("Source", "Symbol", "Footprint", "Value", "MPN", "Manufacturer"))
        self.assertIn("Ctrl+V", client.STRINGS["clipboard_title"])
        self.assertIn("no library files", client.STRINGS["clipboard_hint"])

    def test_make_body_distinguishes_mpn_and_datasheet_url(self) -> None:
        self.assertEqual(client.make_body("TPS7A02"), {"mpn": "TPS7A02"})
        self.assertEqual(
            client.make_body("https://www.ti.com/lit/ds/symlink/tps7a02.pdf"),
            {"datasheetUrl": "https://www.ti.com/lit/ds/symlink/tps7a02.pdf"},
        )
        with self.assertRaisesRegex(ValueError, "mpn or datasheetUrl"):
            client.make_body("  ")

    def test_daemon_json_prefers_explicit_env_then_app_support(self) -> None:
        env = {
            "FABPLANE_DAEMON_JSON": "/tmp/explicit.json",
            "FABDESK_HOME": "/tmp/fabdesk-home",
            "HOME": "/home/lab",
            "XDG_CONFIG_HOME": "/home/lab/.config",
        }
        paths = client.daemon_json_candidates(env, home="/home/lab", platform="linux")
        self.assertEqual(paths[0], "/tmp/explicit.json")
        self.assertIn("/tmp/fabdesk-home/daemon.json", paths)
        self.assertIn("/home/lab/.config/fabPlane/daemon.json", paths)
        self.assertIn("/home/lab/.config/fabPlane Dev/daemon.json", paths)
        self.assertIn("/home/lab/.config/fabdesk/daemon.json", paths)

        found = client.find_daemon_json(
            env,
            home="/home/lab",
            platform="linux",
            exists=lambda path: path.endswith("fabPlane Dev/daemon.json"),
        )
        self.assertTrue(found.endswith("fabPlane Dev/daemon.json"))

    def test_macos_user_data_paths(self) -> None:
        paths = client.daemon_json_candidates(
            {"HOME": "/Users/lab"},
            home="/Users/lab",
            platform="darwin",
        )
        self.assertIn("/Users/lab/Library/Application Support/fabPlane/daemon.json", paths)
        self.assertIn("/Users/lab/Library/Application Support/fabdesk-dev/daemon.json", paths)


class FakeDaemon(BaseHTTPRequestHandler):
    directory: dict[str, object] = {}

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.headers.get("Authorization") != "Bearer secret":
            self._send(401, {"error": "cloud_signed_out", "message": "sign in"})
            return
        if self.path == "/parts-picker":
            self._send(200, {"signedIn": True, "orgId": "org-1", "orgName": "Lab", "makeThisPart": True})
            return
        if self.path.startswith("/parts-picker/search"):
            self._send(
                200,
                {
                    "hits": [
                        {
                            "id": "team:1",
                            "source": "team",
                            "sourceLabel": "Team library",
                            "symbol": "Device:R",
                            "footprint": "Resistor_SMD:R_0402_1005Metric",
                            "value": "10k",
                            "mpn": "RC0402FR-0710KL",
                            "manufacturer": "Yageo",
                            "pasteable": True,
                        }
                    ],
                    "makeThisPart": False,
                    "message": "1 match. Pick one, then paste into the schematic.",
                },
            )
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.headers.get("Authorization") != "Bearer secret":
            self._send(401, {"error": "cloud_signed_out"})
            return
        payload = self._read_json()
        if self.path == "/parts-picker/paste":
            self._send(
                200,
                {
                    "pasteable": True,
                    "paste": '(kicad_sch (lib_symbols) (symbol (lib_id "Device:R") (property "Footprint" "x")))',
                    "part": payload,
                },
            )
            return
        if self.path == "/parts-picker/make":
            self._send(
                201,
                {
                    "created": True,
                    "paste": '(kicad_sch (lib_symbols) (symbol (lib_id "fabplane:TPS7A02") (property "Footprint" "x")))',
                    "part": payload,
                },
            )
            return
        self._send(404, {"error": "not_found"})


class HttpClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = HTTPServer(("127.0.0.1", 0), FakeDaemon)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = client.PartsPickerClient(
            {"host": "127.0.0.1", "port": self.server.server_address[1], "token": "secret"}
        )

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def test_status_search_paste_make(self) -> None:
        status = self.client.status()
        self.assertEqual(status["orgName"], "Lab")
        found = self.client.search("RC0402")
        self.assertEqual(found["hits"][0]["mpn"], "RC0402FR-0710KL")
        paste = self.client.paste(found["hits"][0])
        self.assertIn("(kicad_sch", paste["paste"])
        made = self.client.make("TPS7A02")
        self.assertTrue(made["created"])

    def test_signed_out(self) -> None:
        bad = client.PartsPickerClient(
            {"host": "127.0.0.1", "port": self.server.server_address[1], "token": "wrong"}
        )
        with self.assertRaises(client.DaemonError) as ctx:
            bad.status()
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(ctx.exception.code, "cloud_signed_out")

    def test_connect_reads_daemon_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "daemon.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "version": "test",
                        "pid": os.getpid(),
                        "port": self.server.server_address[1],
                        "host": "127.0.0.1",
                        "token": "secret",
                        "startedAt": 0,
                        "channel": "internal",
                        "authMode": "fabplane",
                    },
                    handle,
                )
            connected = client.connect({"FABPLANE_DAEMON_JSON": path})
            self.assertEqual(connected.status()["orgName"], "Lab")


if __name__ == "__main__":
    unittest.main()
