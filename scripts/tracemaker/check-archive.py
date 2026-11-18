#!/usr/bin/env python3
"""Reject incomplete distributable binary archives before publication."""
import json
import importlib.util
from pathlib import Path
import sys
import re
import tarfile
import zipfile

def check_archive(path, asset):
    if asset.get('format') == 'zip':
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            contents = {n.removeprefix("./"): archive.read(n) for n in names if not n.endswith("/")}
    else:
        with tarfile.open(path) as archive:
            names = archive.getnames()
            contents = {m.name.removeprefix("./"): archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
    names = {n.removeprefix('./') for n in names}
    required = {'LICENSE', 'NOTICE', 'SOURCE.txt', 'DEPENDENCIES.txt',
                'corresponding-source/upstream.tar.gz', 'corresponding-source/build.patch',
                'corresponding-source/dependency-install-workflow.yml',
                'corresponding-source/dependencies/SHA256.json',
                asset['executable'], asset.get('placer', 'MISSING-PLACER')}
    if not required <= names:
        raise ValueError(f'{path}: missing {required - names}')
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
    import hashlib
    source_root = 'corresponding-source/dependencies/'
    hashes = json.loads(contents[source_root + 'SHA256.json'])
    for name, sha in hashes.items():
        data = contents.get(source_root + name)
        if data is None or hashlib.sha256(data).hexdigest() != sha:
            raise ValueError(f'{path}: corrupt dependency source {name}')
    for component in ['boost', 'eigen', 'cli11', 'nlohmann', 'zstd']:
        if not any(n.startswith(component) for n in hashes):
            raise ValueError(f'{path}: missing dependency source {component}')
    if not asset['platform'].startswith('macos-') or licensed('sqlite'):
        if not any(n.startswith('sqlite') for n in hashes):
            raise ValueError(f'{path}: missing SQLite source')
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
              ['gcc', 'stdc++'] if asset['platform'].startswith('linux-') else
              ['llvm'] if asset.get('cxxRuntime') == 'llvm-static' else [])
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
        records = json.loads(contents[source_root + identity_name])
        if set(records) != deps.COMPONENTS:
            raise ValueError(f'{path}: incomplete Linux dependency source identities')
        for component, record in records.items():
            for name, sha in record['files'].items():
                if Path(name).name != name or hashes.get(component + '/' + name) != sha:
                    raise ValueError(f'{path}: missing {component} source input {name}')
            deps.validate_identity(component, record, lambda name: contents[source_root + component + '/' + name])
    if asset.get('cxxRuntime') == 'llvm-static' and not licensed('llvm'):
        raise ValueError(f'{path}: missing LLVM licenses')

if __name__ == '__main__':
    root = Path(sys.argv[1])
    for path in root.glob('*/asset.json'):
        asset = json.loads(path.read_text())
        check_archive(path.parent / asset['filename'], asset)
