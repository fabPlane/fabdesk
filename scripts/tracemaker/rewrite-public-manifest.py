#!/usr/bin/env python3
"""Rewrite TraceMaker manifest asset URLs onto a public base. sha256/bytes stay identical."""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.parse


def public_asset_url(base: str, tag: str, filename: str) -> str:
    base = base.rstrip("/")
    quoted = urllib.parse.quote(filename, safe=".-_~")
    return f"{base}/{tag}/{quoted}"


def rewrite(manifest: dict, base: str, tag: str) -> dict:
    out = json.loads(json.dumps(manifest))
    assets = out.get("assets")
    if not isinstance(assets, list):
        raise SystemExit("manifest is missing assets[]")
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        filename = asset.get("filename")
        if not filename:
            raise SystemExit("asset is missing filename")
        asset["url"] = public_asset_url(base, tag, str(filename))
        if asset.get("source"):
            asset["source"]["url"] = public_asset_url(base, tag, asset["source"]["filename"])
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--out", required=True)
    opts = parser.parse_args()
    raw = json.loads(pathlib.Path(opts.manifest).read_text(encoding="utf-8"))
    rewritten = rewrite(raw, opts.base_url, opts.tag)
    dest = pathlib.Path(opts.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(rewritten, indent=2) + "\n", encoding="utf-8")
    print(f"rewrote {len(rewritten.get('assets', []))} asset URLs onto {opts.base_url.rstrip('/')}/{opts.tag}/")


if __name__ == "__main__":
    sys.exit(main())
