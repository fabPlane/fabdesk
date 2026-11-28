import json
from pathlib import Path
import subprocess
import sys
import unittest


class CandidateMatrixTests(unittest.TestCase):
    def test_filters_platforms_before_allocating_runners(self):
        script = Path(__file__).parents[1] / "candidate-matrix.py"
        def matrix(platform):
            return json.loads(subprocess.check_output([sys.executable, script, platform]))["include"]

        mac, linux, windows = (matrix(platform) for platform in ("macos", "linux", "windows"))
        self.assertEqual([(r["target"], r.get("move")) for r in mac], [("darwin-arm64", None), ("darwin-x64", "1")])
        self.assertEqual([(r["target"], r["ext"]) for r in linux], [("linux-x64", "AppImage"), ("linux-x64", "deb")])
        self.assertEqual([(r["target"], r["ext"]) for r in windows], [("windows-x64", "exe")])
        self.assertEqual(matrix("all"), mac + linux + windows)
