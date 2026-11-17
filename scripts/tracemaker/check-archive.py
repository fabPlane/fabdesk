#!/usr/bin/env python3
"""Reject incomplete distributable binary archives before publication."""
import json
from pathlib import Path
import sys
import re
import tarfile
import zipfile

def check_archive(path, asset):
    if asset.get('format') == 'zip':
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    else:
        with tarfile.open(path) as archive:
            names = archive.getnames()
    names = {n.removeprefix('./') for n in names}
    required = {'LICENSE', 'NOTICE', 'SOURCE.txt', 'DEPENDENCIES.txt',
                'corresponding-source/upstream.tar.gz', 'corresponding-source/build.patch',
                asset['executable'], asset.get('placer', 'MISSING-PLACER')}
    if not required <= names:
        raise ValueError(f'{path}: missing {required - names}')
    for component in ['zstd', 'sqlite', 'gcc', 'boost', 'eigen', 'cli11', 'nlohmann']:
        # System SQLite/libc++ on macOS is supplied by the OS.
        if asset['platform'].startswith('macos-') and component in ['sqlite', 'gcc']:
            continue
        if not any(n.startswith('licenses/') and component in n.lower() for n in names):
            raise ValueError(f'{path}: missing {component} license')
    # A newly introduced shared dependency must bring its own license rather
    # than silently passing a fixed checklist for today's toolchain.
    for name in names:
        base = Path(name).name.lower()
        if not re.search(r'\.(so(?:\.|$)|dll$|dylib$)', base):
            continue
        components = {'zstd': 'zstd', 'sqlite': 'sqlite', 'stdc++': 'stdc++',
                      'gcc': 'gcc', 'gomp': 'gcc', 'boost': 'boost', 'winpthread': 'winpthread'}
        component = next((v for k, v in components.items() if k in base), None)
        if not component or not any(n.startswith('licenses/') and (component in n.lower() or (component == 'stdc++' and 'gcc' in n.lower())) for n in names):
            raise ValueError(f'{path}: unlicensed shared dependency {base}')
    if asset.get('cxxRuntime') == 'llvm-static' and not any(n.startswith('licenses/llvm/') for n in names):
        raise ValueError(f'{path}: missing LLVM licenses')

if __name__ == '__main__':
    root = Path(sys.argv[1])
    for path in root.glob('*/asset.json'):
        asset = json.loads(path.read_text())
        check_archive(path.parent / asset['filename'], asset)
