"""fabPlane parts picker — KiCad ActionPlugin (Schematic Editor and PCB Editor)."""

from __future__ import annotations

import os
import sys

_DIR = os.path.dirname(__file__)
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)


def register() -> None:
    try:
        from .plugin import register as _register
    except ImportError:
        from plugin import register as _register  # type: ignore

    _register()


try:
    register()
except Exception:
    # KiCad loads this folder by path; missing pcbnew/wx must not break `python3 test_plugin.py`.
    pass
