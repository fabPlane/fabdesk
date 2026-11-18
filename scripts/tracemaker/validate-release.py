#!/usr/bin/env python3
"""Require the complete router + placer platform set before any publication."""
import json
import hashlib
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
    for asset in assets:
        source = asset.get('source', {})
        filename = source.get('filename', '')
        if not filename or Path(filename).name != filename: raise ValueError('Missing source bundle identity')
        directory = path.parent if mode == 'manifest' else next(p.parent for p in sorted(path.glob('*/asset.json')) if json.loads(p.read_text()) == asset)
        candidates = [directory / filename] if mode == 'artifacts' else list(directory.rglob(filename))
        found = False
        for bundle in candidates:
            if not bundle.is_file(): continue
            with bundle.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() == source.get('sha256'): found = True; break
        if not found: raise ValueError('Missing or corrupt source bundle')
