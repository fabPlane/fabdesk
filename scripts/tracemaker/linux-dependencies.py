#!/usr/bin/env python3
"""Resolve actual Debian file owners; retain exact source packages and patches.

linux-dependencies.py sources DEST [--cache DOWNLOADED_SOURCE_PACKAGES]
linux-dependencies.py reconstruct DEST OUTPUT  # offline, verifies hashes first
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess

HEADERS = {'boost': '/usr/include/boost/version.hpp', 'eigen': '/usr/include/eigen3/Eigen/Core',
           'cli11': '/usr/include/CLI/CLI.hpp', 'nlohmann': '/usr/include/nlohmann/json.hpp',
           'zstd': '/usr/include/zstd.h', 'sqlite': '/usr/include/sqlite3.h'}

def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()

def owner(path):
    # A multiarch owner contains a colon; split at the path separator instead.
    return run('dpkg-query', '-S', path).split(': /')[0]

CXX_HEADERS = {'stdc++-headers': 'vector', 'stdc++-config': 'bits/c++config.h'}
COMPONENTS = set(HEADERS) | {'gcc', 'stdc++'} | set(CXX_HEADERS)

def source_components(names):
    # MPL Eigen headers and GCC implementation/configuration headers are
    # compiled in. Retain runtime sources only for libraries actually bundled.
    components = {'eigen'} | set(CXX_HEADERS)
    if any('libgcc_s' in name for name in names): components.add('gcc')
    if any('libstdc++' in name for name in names): components.add('stdc++')
    return components

def cxx_headers(compiler):
    # Line markers follow the compiler's actual include search, including the
    # multiarch config directory. Never infer a GCC version from the runtime.
    preprocessed = run(compiler, '-E', '-x', 'c++', '-', input='#include <vector>\n')
    included = set(re.findall(r'^# \d+ "(/[^"\n]+)"', preprocessed, re.M))
    paths = {}
    for component, suffix in CXX_HEADERS.items():
        matches = {path for path in included if path.endswith('/' + suffix)}
        if len(matches) != 1:
            raise ValueError(f'Cannot resolve {component} through {compiler}: {matches}')
        paths[component] = matches.pop()
    return paths

def validate_identity(component, record, read_file):
    for field in ('package', 'version', 'source', 'sourceVersion'):
        if not isinstance(record.get(field), str) or not record[field]:
            raise ValueError(f'Missing {component} source identity: {field}')
    if component in CXX_HEADERS and not record.get('header', '').endswith('/' + CXX_HEADERS[component]):
        raise ValueError(f'Missing {component} implementation header identity')
    dscs = [name for name in record['files'] if name.endswith('.dsc')]
    if len(dscs) != 1:
        raise ValueError(f'Missing {component} source package')
    text = '\n' + read_file(dscs[0]).decode()
    for field, value in [('Source', record['source']), ('Version', record['sourceVersion'])]:
        if f'\n{field}: {value}\n' not in text:
            raise ValueError(f'Mismatched {component} source identity: {field}')


def identities():
    result = {}
    compiler = os.environ.get('CXX', 'g++')
    paths = dict(HEADERS, **cxx_headers(compiler))
    for component, filename in [('gcc', 'libgcc_s.so.1'), ('stdc++', 'libstdc++.so')]:
        paths[component] = str(Path(run(compiler, '-print-file-name=' + filename)).resolve(strict=True))
    for component, header in paths.items():
        package = owner(header)
        fields = run('dpkg-query', '-W', '-f=${Version}\t${source:Package}\t${source:Version}', package).split('\t')
        result[component] = dict(package=package, version=fields[0], source=fields[1], sourceVersion=fields[2], header=header)
    return result

def licenses(dest):
    records = identities()
    dest.mkdir(parents=True, exist_ok=True)
    for component, record in records.items():
        notice = Path('/usr/share/doc') / record['package'].split(':')[0] / 'copyright'
        shutil.copyfile(notice, dest / (component + '.txt'))
        print(f'{component}: {record["package"]} {record["version"]} <- {notice}')
    shutil.copytree('/usr/share/common-licenses', dest / 'common-licenses', dirs_exist_ok=True)
    (dest / 'installed-packages.json').write_text(json.dumps(records, indent=2) + '\n')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def sources(dest, cache=None, components=None):
    dest.mkdir(parents=True, exist_ok=True)
    records = identities()
    if components is not None: records = {k:v for k,v in records.items() if k in components}
    previous = {}
    for component, record in records.items():
        target = dest / component
        target.mkdir()
        identity = (record['source'], record['sourceVersion'])
        if identity in previous:
            for path in previous[identity].iterdir():
                if path.is_file(): os.link(path, target / path.name)
        elif cache:
            # Cache is an apt-get source --download-only directory, not an
            # extracted upstream tarball: require the .dsc and Debian patches.
            candidates = []
            for dsc in cache.glob('*.dsc'):
                text = dsc.read_text()
                if f'\nSource: {record["source"]}\n' in '\n' + text and f'\nVersion: {record["sourceVersion"]}\n' in '\n' + text:
                    candidates.append(dsc)
            if len(candidates) != 1:
                raise ValueError(f'Need exactly one cached .dsc for {record}')
            dsc = candidates[0]
            shutil.copyfile(dsc, target / dsc.name)
            # Checksums-Sha256 is the authoritative complete source member list.
            members = dsc_members(dsc)
            for filename, sha in members.items():
                path = cache / filename
                if digest(path) != sha: raise ValueError(f'Bad source hash: {path}')
                shutil.copyfile(path, target / filename)
        else:
            subprocess.run(['apt-get', 'source', '--download-only', '--', record['source'] + '=' + record['sourceVersion']], cwd=target, check=True)
        previous[identity] = target
        record['files'] = {p.name: digest(p) for p in target.iterdir() if p.is_file()}
        validate_identity(component, record, lambda name: (target / name).read_bytes())
    (dest / 'inputs.json').write_text(json.dumps(records, indent=2) + '\n')
    (dest / 'EXCLUSIONS.txt').write_text('System glibc and OS libraries are excluded. Permissive Boost, CLI11, nlohmann_json, BSD zstd and public-domain SQLite retain notices, not source packages. General-purpose toolchain binaries are excluded. The GCC source package is retained to cover the copied runtime libraries and compiled-in C++ implementation/configuration headers, not to distribute a compiler binary.\n')

def dsc_members(path):
    members = {}
    active = False
    for line in path.read_text().splitlines():
        if line == 'Checksums-Sha256:': active = True; continue
        if active and not line.startswith(' '): break
        if active:
            sha, _, name = line.split()
            if Path(name).name != name: raise ValueError('Unsafe source member')
            members[name] = sha
    if not members: raise ValueError('Missing source SHA256 list')
    return members

def reconstruct(dest, output):
    records = json.loads((dest / 'inputs.json').read_text())
    if not ({'eigen'} | set(CXX_HEADERS)) <= set(records) or not set(records) <= COMPONENTS: raise ValueError('Incomplete source inputs')
    output.mkdir(parents=True, exist_ok=True)
    for component, record in records.items():
        folder = dest / component
        for filename, sha in record['files'].items():
            if Path(filename).name != filename or digest(folder / filename) != sha:
                raise ValueError(f'Corrupt source input: {component}/{filename}')
        validate_identity(component, record, lambda name: (folder / name).read_bytes())
        dsc, = folder.glob('*.dsc')
        subprocess.run(['dpkg-source', '--no-check', '-x', str(dsc.resolve()), str((output / component).resolve())], check=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['licenses', 'sources', 'reconstruct'])
    parser.add_argument('dest', type=Path)
    parser.add_argument('output', nargs='?', type=Path)
    parser.add_argument('--cache', type=Path)
    args = parser.parse_args()
    if args.action == 'licenses': licenses(args.dest)
    elif args.action == 'sources':
        bundle = os.environ.get('TRACEMAKER_BUNDLED_DIR')
        names = [p.name for p in Path(bundle).rglob('*')] if bundle else []
        sources(args.dest, args.cache, source_components(names))
    else: reconstruct(args.dest, args.output)
