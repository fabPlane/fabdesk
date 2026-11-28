"""Select the native installer cases before GitHub allocates one-click test runners."""
import argparse
import json


CASES = {
    "macos": [
        dict(label="Mac Apple Silicon", os="macos-15", target="darwin-arm64", ext="dmg"),
        dict(label="Mac Intel from mounted DMG", os="macos-15-intel", target="darwin-x64", ext="dmg", move="1"),
    ],
    "linux": [
        dict(label="Linux AppImage", os="ubuntu-22.04", target="linux-x64", ext="AppImage"),
        dict(label="Linux Debian", os="ubuntu-22.04", target="linux-x64", ext="deb"),
    ],
    "windows": [dict(label="Windows NSIS", os="windows-2025", target="windows-x64", ext="exe")],
}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform", choices=["all", *CASES])
    platform = parser.parse_args().platform
    cases = [case for group in CASES.values() for case in group] if platform == "all" else CASES[platform]
    print(json.dumps({"include": cases}, separators=(",", ":")))
