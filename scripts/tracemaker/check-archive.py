#!/usr/bin/env python3
"""Reject incomplete distributable binary archives before publication."""
import json
import hashlib
import importlib.util
from pathlib import Path
import sys
import re
import tarfile
import zipfile

MAX_BINARY_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 192 * 1024 * 1024

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def check_archive(path, asset):
    if path.stat().st_size > MAX_BINARY_BYTES:
        raise ValueError(f'{path}: binary archive too large (limit 64 MiB)')
    if asset.get('format') == 'zip':
        with zipfile.ZipFile(path) as archive:
            if sum(i.file_size for i in archive.infolist()) > MAX_EXPANDED_BYTES: raise ValueError('Binary archive too large expanded')
            names = archive.namelist()
            contents = {n.removeprefix("./"): archive.read(n) for n in names if not n.endswith("/")}
    else:
        with tarfile.open(path) as archive:
            if sum(m.size for m in archive.getmembers()) > MAX_EXPANDED_BYTES: raise ValueError('Binary archive too large expanded')
            names = archive.getnames()
            contents = {m.name.removeprefix("./"): archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
    names = {n.removeprefix('./') for n in names}
    if any(n.startswith('corresponding-source/') or n.endswith(('.tar.gz', '.dsc')) for n in names):
        raise ValueError('Corresponding source inside binary archive')
    required = {'LICENSE', 'NOTICE', 'SOURCE.txt', 'DEPENDENCIES.txt', asset['executable'], asset.get('placer', 'MISSING-PLACER')}
    if not required <= names:
        raise ValueError(f'{path}: missing {required - names}')
    for name in contents:
        if name not in required and not name.startswith(('lib/', 'licenses/')) and not name.lower().endswith('.dll'):
            raise ValueError(f'Unexpected binary archive member: {name}')
    payload = sum(len(data) for name, data in contents.items() if name in {asset['executable'], asset.get('placer')} or name.startswith(('lib/', 'licenses/')) or name.lower().endswith('.dll'))
    if path.stat().st_size > 3 * payload + 1024 * 1024:
        raise ValueError('Binary archive too large relative to programs, libraries and notices')
    source = asset.get('source', {})
    filename = source.get('filename', '')
    if not filename or Path(filename).name != filename or not filename.startswith('tracemaker-source-'):
        raise ValueError('Missing source bundle identity')
    source_path = path.parent / filename
    if not source_path.is_file() or digest(source_path) != source.get('sha256'):
        raise ValueError('Missing or corrupt source bundle')
    offer = contents['SOURCE.txt'].decode()
    if source.get('url', '').rsplit('/', 1)[-1] != filename or filename not in offer or source['sha256'] not in offer:
        raise ValueError('SOURCE.txt does not identify the matching source bundle')
    source_archive = tarfile.open(source_path)
    try:
        check_source(source_archive, asset, contents, names, path)
    finally:
        source_archive.close()

def check_source(source_archive, asset, contents, names, path):
    def open_source(name):
        for candidate in [name, './' + name]:
            try:
                member = source_archive.getmember(candidate)
                if member.isfile() or member.islnk(): return source_archive.extractfile(member)
            except KeyError: pass
        raise ValueError(f'Missing source bundle member {name}')
    def read_source(name):
        with open_source(name) as stream: return stream.read()
    for name in ['upstream.tar.gz', 'build.patch', 'dependency-install-workflow.yml']:
        read_source(name)
    if not any(m.name.removeprefix('./').startswith('build-scripts/') for m in source_archive.getmembers()):
        raise ValueError('Missing build scripts')
    patterns = {
        'zstd': r'BSD|Redistribution and use in source and binary',
        'sqlite': r'public.domain|The author disclaims copyright to this source code',
        'gcc': r'GPL|GNU (?:Library |Lesser )?General Public License',
        'boost': r'Boost Software License|BSL-1[.]0',
        'eigen': r'MPL-2|Mozilla Public License',
        'cli11': r'BSD|Redistribution and use in source and binary',
        'nlohmann': r'MIT|Expat|Permission is hereby granted',
        'llvm': r'Apache License|Apache-2[.]0',
    }
    def licensed(component):
        return any(n.startswith('licenses/') and component in n.lower() and
                   re.search(patterns.get(component, r'copyright|permission|license'),
                             data.decode('utf-8', errors='replace'), re.I)
                   for n, data in contents.items())
    for component in ['zstd', 'sqlite', 'gcc', 'boost', 'eigen', 'cli11', 'nlohmann']:
        if asset['platform'].startswith('macos-') and component in ['sqlite', 'gcc']:
            continue
        if not licensed(component):
            raise ValueError(f'{path}: missing meaningful {component} license text')
    source_root = 'dependencies/'
    hashes = json.loads(read_source(source_root + 'SHA256.json'))
    for name, sha in hashes.items():
        if Path(name).is_absolute() or '..' in Path(name).parts: raise ValueError('Unsafe source input')
        with open_source(source_root + name) as stream:
            got = hashlib.file_digest(stream, 'sha256').hexdigest()
        if got != sha:
            raise ValueError(f'{path}: corrupt dependency source {name}')
    if not any(n.startswith('eigen/') for n in hashes):
        raise ValueError('Missing MPL Eigen header source')
    # A newly introduced shared dependency must bring its own license rather
    # than silently passing a fixed checklist for today's toolchain.
    for name in names:
        base = Path(name).name.lower()
        if not re.search(r'\.(so(?:\.|$)|dll$|dylib$)', base):
            continue
        components = {'zstd': 'zstd', 'sqlite': 'sqlite', 'stdc++': 'stdc++',
                      'gcc': 'gcc', 'gomp': 'gcc', 'boost': 'boost', 'winpthread': 'winpthread'}
        component = next((v for k, v in components.items() if k in base), None)
        if not component or not licensed('gcc' if component == 'stdc++' else component):
            raise ValueError(f'{path}: unlicensed shared dependency {base}')
    extras = (['gcc', 'winpthreads'] if asset['platform'].startswith('windows-') else
              [c for c, library in [('gcc', 'libgcc_s'), ('stdc++', 'libstdc++')] if any(library in n for n in names)] if asset['platform'].startswith('linux-') else
              [])
    for component in extras:
        if not any(n.startswith(component + '/') for n in hashes):
            raise ValueError(f'{path}: missing {component} runtime source')
    if asset['platform'].startswith('linux-'):
        spec = importlib.util.spec_from_file_location('linux_dependencies', Path(__file__).with_name('linux-dependencies.py'))
        deps = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deps)
        identity_name = 'inputs.json'
        if identity_name not in hashes:
            raise ValueError(f'{path}: missing Linux dependency source identities')
        records = json.loads(read_source(source_root + identity_name))
        if set(records) != deps.source_components(names):
            raise ValueError(f'{path}: incomplete Linux dependency source identities')
        for component, record in records.items():
            for name, sha in record['files'].items():
                if Path(name).name != name or hashes.get(component + '/' + name) != sha:
                    raise ValueError(f'{path}: missing {component} source input {name}')
            deps.validate_identity(component, record, lambda name: read_source(source_root + component + '/' + name))
    if asset.get('cxxRuntime') == 'llvm-static' and not licensed('llvm'):
        raise ValueError(f'{path}: missing LLVM licenses')

if __name__ == '__main__':
    root = Path(sys.argv[1])
    records = list(root.glob('*/asset.json'))
    if not records and (root / 'manifest.json').is_file():
        assets = json.loads((root / 'manifest.json').read_text())['assets']
        for asset in assets:
            candidates = [p for p in root.rglob(asset['filename']) if p.is_file() and digest(p) == asset['sha256']]
            if not candidates: raise ValueError('Missing binary archive')
            check_archive(candidates[0], asset)
    else:
        if not records: raise ValueError('Missing archive manifest')
        for path in records:
            asset = json.loads(path.read_text())
            check_archive(path.parent / asset['filename'], asset)
