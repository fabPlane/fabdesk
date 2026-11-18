#!/usr/bin/env python3
"""Require the complete router + placer platform set before any publication."""
import json
from pathlib import Path
import sys

REQUIRED = {'linux-x86_64', 'macos-arm64'}

def validate_assets(assets):
    platforms = [asset['platform'] for asset in assets]
    if not REQUIRED <= set(platforms):
        raise ValueError(f'Release lacks required platforms: {sorted(REQUIRED - set(platforms))}')
    if len(platforms) != len(set(platforms)):
        raise ValueError('Duplicate release platform')
    for asset in assets:
        expected = 'tracemaker-place.exe' if asset['platform'].startswith('windows-') else 'tracemaker-place'
        if asset.get('placer') != expected:
            raise ValueError(f'Release lacks placer for {asset["platform"]}')

if __name__ == '__main__':
    mode, filename = sys.argv[1:]
    path = Path(filename)
    if mode == 'artifacts':
        records = [json.loads(p.read_text()) for p in sorted(path.glob('*/asset.json'))]
        # Match publish.sh's deterministic selection of one artifact per platform.
        assets = list({a['platform']: a for a in records}.values())
    elif mode == 'manifest':
        assets = json.loads(path.read_text())['assets']
    else:
        raise ValueError('Expected artifacts or manifest')
    validate_assets(assets)
