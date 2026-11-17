#!/usr/bin/env python3
"""Release gate R1: intentionally red until the lead ships the first verified pin."""
import json
import re
from pathlib import Path
from urllib.parse import urlparse

pin = json.loads((Path(__file__).resolve().parents[2] / 'packages/tools/src/routers/tracemaker-pin.json').read_text())
assets = {a['platform']: a for a in pin['assets']}
for platform in ['linux-x86_64', 'macos-arm64']:
    asset = assets[platform]
    assert asset.get('placer') == 'tracemaker-place', f'R1: shipped {platform} pin needs placer'
    url = urlparse(asset['url'])
    assert url.scheme == 'https' and url.netloc == 'downloads.fabplane.com', f'R1: non-public pin {url}'
    assert '/tracemaker/' in url.path and '/tracemaker-latest/' not in url.path, f'R1: mutable pin {url}'
    assert re.fullmatch(r'/tracemaker/tracemaker-[^/]+-b[0-9]+-[0-9]+/[^/]+', url.path), f'R1: pin URL lacks an immutable run/attempt build directory {url}'
    assert url.path.rsplit('/', 1)[1] == asset['filename'], f'R1: pin filename/URL mismatch {url}'
print('Shipped pin includes both required platforms, placer and immutable public URLs')
