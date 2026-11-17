#!/usr/bin/env python3
"""Validate a published candidate and copy its exact manifest bytes into the pin."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlparse

REQUIRED = {'linux-x86_64', 'macos-arm64'}

def update_pin(manifest, pin):
    body = Path(manifest).read_bytes()
    value = json.loads(body)
    assets = value['assets']
    if not REQUIRED <= {a['platform'] for a in assets}:
        raise ValueError('candidate lacks required platforms')
    for asset in assets:
        url = urlparse(asset['url'])
        if (not asset.get('placer') or not re.fullmatch('[0-9a-f]{64}', asset['sha256'])
                or url.scheme != 'https' or 'tracemaker-latest' in url.path):
            raise ValueError('candidate must have placer, sha256 and immutable HTTPS URLs')
    Path(pin).write_bytes(body)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest')
    parser.add_argument('pin')
    args = parser.parse_args()
    update_pin(args.manifest, args.pin)
