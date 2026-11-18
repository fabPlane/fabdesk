"""Offline regression checks; no sockets, credentials or publication."""
import importlib.util
import json
import pathlib
import tempfile
import shutil
import subprocess
import os
import tarfile
import io
import unittest
from unittest.mock import patch
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parent

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class Pin(unittest.TestCase):
    def test_pin_is_exact_manifest_and_requires_placer(self):
        update = module('update-pin')
        with tempfile.TemporaryDirectory() as folder:
            pin = pathlib.Path(folder) / 'pin.json'
            manifest = pathlib.Path(folder) / 'manifest.json'
            candidate = {'upstream': {'tag': 'v99.0.0'}, 'assets': [
                {'platform': p, 'placer': 'tracemaker-place', 'sha256': 'a'*64,
                 'url': 'https://downloads.fabplane.com/tracemaker/build/file'}
                for p in ['linux-x86_64', 'macos-arm64']]}
            manifest.write_text(json.dumps(candidate))
            update.update_pin(manifest, pin)
            self.assertEqual(pin.read_bytes(), manifest.read_bytes())
            candidate['assets'][0].pop('placer')
            manifest.write_text(json.dumps(candidate))
            before = pin.read_bytes()
            with self.assertRaises(ValueError):
                update.update_pin(manifest, pin)
            self.assertEqual(pin.read_bytes(), before)

    def test_macos_static_sqlite_disclaimer_notice(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            include = root / 'include'; include.mkdir()
            header = ROOT / 'fixtures/sqlite3-notice.h'
            shutil.copyfile(header, include / 'sqlite3.h')
            source = root / 'source.tar.gz'
            with tarfile.open(source, 'w:gz') as archive:
                body = b'BSD MIT Boost Software License MPL-2'
                info = tarfile.TarInfo('source/LICENSE'); info.size = len(body)
                archive.addfile(info, io.BytesIO(body))
            brew = root / 'brew'
            brew.write_text("""#!/bin/sh
case "$1" in
--prefix) echo "$FIXTURE_ROOT";;
info) echo '{"formulae":[{"installed":[{"version":"1.0"}],"versions":{"stable":"1.0"}}]}';;
--cache) echo "$FIXTURE_ROOT/source.tar.gz";;
fetch) :;;
*) exit 1;;
esac
""")
            brew.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       FIXTURE_ROOT=str(root), TRACEMAKER_LINK_NOTE='static libsqlite3.a')
            result = subprocess.run(['bash', str(ROOT / 'collect-licenses.sh'), 'macos-arm64', str(root / 'licenses')],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            notice = (root / 'licenses/sqlite/NOTICE.txt').read_text()
            self.assertIn('The author disclaims copyright to this source code.', notice)
            self.assertIn('May you do good and not evil.', notice)
            self.assertNotIn('public domain', header.read_text().lower())
            (include / 'sqlite3.h').write_text('/* no legal notice */')
            bad = subprocess.run(['bash', str(ROOT / 'collect-licenses.sh'), 'macos-arm64', str(root / 'bad-licenses')], env=env, capture_output=True)
            self.assertNotEqual(bad.returncode, 0)

    def test_mirror_lookup_failure_preserves_existing_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            scripts = root / 'scripts'
            shutil.copytree(ROOT, scripts)
            artifacts = root / 'artifacts'
            artifacts.mkdir()
            (artifacts / 'new.tar.gz').write_bytes(b'rebuilt bytes')
            (artifacts / 'manifest.json').write_text(json.dumps({'assets': [dict(platform=p, placer='tracemaker-place', filename='new.tar.gz', sha256='a'*64, url='https://example.test/file', source=dict(filename='source.tar.gz', sha256=__import__('hashlib').sha256(b'source').hexdigest(), url='https://example.test/source.tar.gz')) for p in ['linux-x86_64', 'macos-arm64']]}))
            (artifacts / 'source.tar.gz').write_bytes(b'source')
            existing = root / 'existing.tar.gz'
            existing.write_bytes(b'original immutable bytes')
            log = root / 'calls'
            # The authoritative store rejects HEAD (503); public GET would also
            # fail, as in F45-2. Any attempted PUT would destroy the fixture.
            (scripts / 'check-archive.py').write_text('')
            (scripts / 's3-put.py').write_text(
                'import pathlib,sys\n'
                f'log=pathlib.Path({str(log)!r})\n'
                'log.open("a").write(" ".join(sys.argv)+"\\n")\n'
                'if "--check-absent" in sys.argv: raise SystemExit("HTTP 503")\n'
                f'pathlib.Path({str(existing)!r}).write_bytes(b"overwritten")\n')
            env = {k: v for k, v in os.environ.items() if not k.startswith(('TRACEMAKER_', 'DESKTOP_R2_', 'CLOUDFLARE_'))}
            env.update(TRACEMAKER_RELEASE_TAG='build', TRACEMAKER_S3_BUCKET='bucket',
                       TRACEMAKER_S3_ENDPOINT='https://example.test', TRACEMAKER_PUBLIC_BASE_URL='https://example.test',
                       TRACEMAKER_S3_ACCESS_KEY_ID='fixture', TRACEMAKER_S3_SECRET_ACCESS_KEY='fixture')
            result = subprocess.run(['bash', str(scripts / 'mirror-public.sh'), str(artifacts)],
                                    env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(existing.read_bytes(), b'original immutable bytes')
            self.assertEqual(len(log.read_text().splitlines()), 1)
            self.assertIn('--check-absent', log.read_text())

    def test_publication_requires_both_platforms_and_never_changes_latest(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            scripts = root / 'scripts'; shutil.copytree(ROOT, scripts)
            # Archive validation has its own real fixture test. These fixtures
            # isolate publication control flow with small placeholder archives.
            (scripts / 'check-archive.py').write_text('')
            artifacts = root / 'artifacts'; artifacts.mkdir()
            calls = root / 'calls'
            store = root / 'store'; store.mkdir()
            legacy = store / 'tracemaker/tracemaker-latest/manifest.json'
            legacy.parent.mkdir(parents=True); legacy.write_bytes(b'known legacy pointer')
            (root / 'gh').write_text('#!/bin/sh\necho "$*" >> "$CALLS"\ncase "$*" in *tracemaker-latest*) exit 99;; esac\n')
            (root / 'gh').chmod(0o755)
            (scripts / 's3-put.py').write_text("""import os,sys,pathlib,shutil
args=sys.argv
key=args[args.index('--key')+1]
with open(os.environ['CALLS'],'a') as log: log.write(key+'\\n')
assert 'tracemaker-latest' not in key
path=pathlib.Path(os.environ['STORE'])/key
if '--check-absent' in args:
    assert not path.exists()
else:
    assert '--create-only' in args
    path.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(args[args.index('--file')+1],path)
""")
            (root / 'curl').write_text("""#!/usr/bin/env python3
import os,sys,pathlib,shutil
from urllib.parse import urlparse
args=sys.argv
url=next(a for a in args if a.startswith('https://'))
source=pathlib.Path(os.environ['STORE'])/urlparse(url).path.lstrip('/')
shutil.copyfile(source,args[args.index('-o')+1])
""")
            (root / 'curl').chmod(0o755)
            assets = []
            for platform in ['linux-x86_64', 'macos-arm64']:
                directory = artifacts / platform; directory.mkdir()
                archive = directory / (platform + '.tar.gz'); archive.write_bytes(platform.encode())
                source = directory / ('tracemaker-source-' + platform + '.tar.gz'); source.write_bytes(b'source bundle')
                assets.append(dict(platform=platform, placer='tracemaker-place', filename=archive.name, source=dict(filename=source.name, sha256=hashlib.sha256(source.read_bytes()).hexdigest(), url='https://example.test/tracemaker/build/' + source.name),
                    sha256=hashlib.sha256(archive.read_bytes()).hexdigest(), url='https://example.test/tracemaker/build/' + archive.name))
            env = {k:v for k,v in os.environ.items() if not k.startswith(('TRACEMAKER_', 'DESKTOP_R2_', 'CLOUDFLARE_'))}
            env.update(PATH=str(root)+os.pathsep+os.environ['PATH'], CALLS=str(calls), STORE=str(store),
                GH_TOKEN='fixture', GITHUB_REPOSITORY='fixture/repo', TRACEMAKER_RELEASE_TAG='build',
                TRACEMAKER_UPSTREAM_TAG='v1', TRACEMAKER_UPSTREAM_COMMIT='a'*40, TRACEMAKER_SOURCE_URL='https://example.test/source',
                TRACEMAKER_S3_BUCKET='bucket', TRACEMAKER_S3_ENDPOINT='https://example.test',
                TRACEMAKER_PUBLIC_BASE_URL='https://example.test/tracemaker', TRACEMAKER_S3_ACCESS_KEY_ID='fixture', TRACEMAKER_S3_SECRET_ACCESS_KEY='fixture')
            def stage(candidate):
                for p in artifacts.glob('*/asset.json'): p.unlink()
                for asset in candidate:
                    (artifacts / asset['platform'] / 'asset.json').write_text(json.dumps(asset))
                (artifacts / 'manifest.json').write_text(json.dumps({'assets':candidate}))
            def invoke(script):
                return subprocess.run(['bash', str(scripts / script), str(artifacts)], env=env, capture_output=True, text=True)
            for invalid in [assets[:1], assets[1:], [dict(a, placer='') for a in assets]]:
                stage(invalid)
                for script in ['publish.sh', 'mirror-public.sh']:
                    result = invoke(script)
                    self.assertNotEqual(result.returncode,0,result.stdout)
                    self.assertFalse(calls.exists(),result.stderr)
            stage(assets)
            result = invoke('publish.sh'); self.assertEqual(result.returncode,0,result.stderr)
            for source in artifacts.glob('*/tracemaker-source-*.tar.gz'): shutil.move(source, artifacts / source.name)
            self.assertEqual(len(calls.read_text().splitlines()),1)
            env.update(TRACEMAKER_PUBLIC_RELEASE_REPO='fixture/public', TRACEMAKER_PUBLIC_RELEASE_TOKEN='fixture')
            result = invoke('mirror-public.sh'); self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('tracemaker-latest',calls.read_text())
            self.assertEqual(legacy.read_bytes(), b'known legacy pointer')
            self.assertTrue((artifacts / 'public-manifest.json').exists())
            env['TRACEMAKER_RELEASE_TAG'] = 'tracemaker-latest'
            for script in ['publish.sh','mirror-public.sh']:
                self.assertNotEqual(invoke(script).returncode,0)

    def test_archive_requires_every_bundled_library_license(self):
        checker = module('check-archive')
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'binary.tar.gz'
            names = ['LICENSE', 'NOTICE', 'SOURCE.txt', 'DEPENDENCIES.txt',
                     'corresponding-source/upstream.tar.gz', 'corresponding-source/build.patch',
                     'corresponding-source/build-scripts/build.sh', 'tracemaker', 'tracemaker-place', 'lib/libgcc_s.so.1', 'lib/libstdc++.so.6']
            data = {name: b'x' for name in names}
            def pack():
                import hashlib
                source_path = archive.parent / 'tracemaker-source-linux-x86_64.tar.gz'
                with tarfile.open(source_path, 'w:gz') as tar:
                    for name, body in data.items():
                        if not name.startswith('corresponding-source/'): continue
                        info = tarfile.TarInfo(name.removeprefix('corresponding-source/')); info.size = len(body)
                        tar.addfile(info, io.BytesIO(body))
                asset['source'] = dict(filename=source_path.name, sha256=hashlib.sha256(source_path.read_bytes()).hexdigest(), url='https://example.test/build/' + source_path.name)
                data['SOURCE.txt'] = (asset['source']['url'] + '\nSource copy sha256: ' + asset['source']['sha256']).encode()
                with tarfile.open(archive, 'w:gz') as tar:
                    for name, body in data.items():
                        if name.startswith('corresponding-source/'): continue
                        info = tarfile.TarInfo(name)
                        info.size = len(body)
                        tar.addfile(info, io.BytesIO(body))
            asset = {'platform': 'linux-x86_64', 'executable': 'tracemaker', 'placer': 'tracemaker-place'}
            pack()
            with self.assertRaises(ValueError): checker.check_archive(archive, asset)
            data['corresponding-source/dependency-install-workflow.yml'] = b'install recipe'
            hashes = {}
            import hashlib
            deps = module('linux-dependencies')
            records = {}
            for component in sorted(deps.source_components(['libgcc_s.so.1', 'libstdc++.so.6'])):
                data['licenses/' + component + '.txt'] = b'x'
                name = component + '/source.tar.gz'
                data['corresponding-source/dependencies/' + name] = b'source input'
                hashes[name] = hashlib.sha256(b'source input').hexdigest()
                source = 'gcc-13' if component in deps.CXX_HEADERS else 'fixture-runtime'
                version = '13.3-1' if component in deps.CXX_HEADERS else '14.2-1'
                dsc_name = component + '/source.dsc'
                dsc = f'Source: {source}\nVersion: {version}\n'.encode()
                data['corresponding-source/dependencies/' + dsc_name] = dsc
                hashes[dsc_name] = hashlib.sha256(dsc).hexdigest()
                records[component] = dict(package=source + '-dev', version=version, source=source,
                    sourceVersion=version, header='/include/' + deps.CXX_HEADERS.get(component, 'fixture.h'),
                    files={'source.tar.gz': hashes[name], 'source.dsc': hashes[dsc_name]})
            identity = json.dumps(records).encode()
            data['corresponding-source/dependencies/inputs.json'] = identity
            hashes['inputs.json'] = hashlib.sha256(identity).hexdigest()
            data['corresponding-source/dependencies/SHA256.json'] = json.dumps(hashes).encode()
            pack()
            # Correct filenames with meaningless contents must still fail.
            with self.assertRaisesRegex(ValueError, 'meaningful'): checker.check_archive(archive, asset)
            for name in data:
                if name.startswith('licenses/'):
                    data[name] = b'BSD public domain GPL Boost Software License MPL-2 MIT'
            pack()
            for component in ['zstd', 'sqlite', 'gcc', 'boost', 'eigen', 'cli11', 'nlohmann']:
                data['licenses/' + component + '.txt'] = b'BSD public domain GPL Boost Software License MPL-2 MIT'
            data['licenses/sqlite.txt'] = (ROOT / 'fixtures/sqlite3-notice.h').read_bytes()
            pack()
            checker.check_archive(archive, asset)
            source_path = archive.parent / asset['source']['filename']
            source_path.unlink()
            with self.assertRaisesRegex(ValueError, 'source bundle'): checker.check_archive(archive, asset)
            pack()
            with archive.open('wb') as stream: stream.truncate(checker.MAX_BINARY_BYTES + 1)
            with self.assertRaisesRegex(ValueError, 'too large'): checker.check_archive(archive, asset)
            pack()
            source_path.write_bytes(b'corrupt source')
            with self.assertRaisesRegex(ValueError, 'source bundle'): checker.check_archive(archive, asset)
            pack()
            data['corresponding-source.tar.gz'] = b'forbidden embedded source'
            pack()
            with self.assertRaisesRegex(ValueError, 'inside binary'): checker.check_archive(archive, asset)
            del data['corresponding-source.tar.gz']; pack()
            # Runtime sources alone must not satisfy the Linux gate.
            complete = dict(records)
            for component in deps.CXX_HEADERS:
                records.pop(component)
            data['corresponding-source/dependencies/inputs.json'] = json.dumps(records).encode()
            hashes['inputs.json'] = hashlib.sha256(data['corresponding-source/dependencies/inputs.json']).hexdigest()
            data['corresponding-source/dependencies/SHA256.json'] = json.dumps(hashes).encode()
            pack()
            with self.assertRaisesRegex(ValueError, 'incomplete Linux'):
                checker.check_archive(archive, asset)
            data['corresponding-source/dependencies/inputs.json'] = json.dumps(complete).encode()
            hashes['inputs.json'] = hashlib.sha256(data['corresponding-source/dependencies/inputs.json']).hexdigest()
            data['corresponding-source/dependencies/SHA256.json'] = json.dumps(hashes).encode()
            # A header record pointing at a runtime-version source must fail,
            # even with an internally consistent outer archive hash inventory.
            header_record = complete['stdc++-headers']
            header_record['sourceVersion'] = '14.2-1'
            data['corresponding-source/dependencies/inputs.json'] = json.dumps(complete).encode()
            hashes['inputs.json'] = hashlib.sha256(data['corresponding-source/dependencies/inputs.json']).hexdigest()
            data['corresponding-source/dependencies/SHA256.json'] = json.dumps(hashes).encode()
            pack()
            with self.assertRaisesRegex(ValueError, r'Mismatched stdc\+\+-headers source identity'):
                checker.check_archive(archive, asset)
            header_record['sourceVersion'] = '13.3-1'
            data['corresponding-source/dependencies/inputs.json'] = json.dumps(complete).encode()
            hashes['inputs.json'] = hashlib.sha256(data['corresponding-source/dependencies/inputs.json']).hexdigest()
            data['corresponding-source/dependencies/SHA256.json'] = json.dumps(hashes).encode()
            data['licenses/boost.txt'] = b'MIT boost-defaults metapackage'
            pack()
            with self.assertRaisesRegex(ValueError, 'boost'): checker.check_archive(archive, asset)

    def test_linux_offline_source_reconstruction_preserves_distro_patch(self):
        deps = module('linux-dependencies')
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            cache = root / 'cache'; cache.mkdir()
            def tarball(path, files):
                with tarfile.open(path, 'w:gz') as tar:
                    for name, body in files.items():
                        body = body.encode(); info = tarfile.TarInfo(name); info.size = len(body)
                        tar.addfile(info, io.BytesIO(body))
            tarball(cache / 'fixture_1.0.orig.tar.gz', {'fixture-1.0/input.h': 'original\n'})
            tarball(cache / 'fixture_1.0-1.debian.tar.gz', {
                'debian/source/format': '3.0 (quilt)\n',
                'debian/rules': '#!/usr/bin/make -f\n',
                'debian/patches/series': 'installed.patch\n',
                'debian/patches/installed.patch': '--- a/input.h\n+++ b/input.h\n@@ -1 +1 @@\n-original\n+distribution-patched\n'})
            dsc = 'Format: 3.0 (quilt)\nSource: fixture\nVersion: 1.0-1\nChecksums-Sha256:\n'
            for path in cache.iterdir():
                dsc += f' {hashlib.sha256(path.read_bytes()).hexdigest()} {path.stat().st_size} {path.name}\n'
            dsc += 'Files:\n'
            for path in cache.iterdir():
                dsc += f' {hashlib.md5(path.read_bytes()).hexdigest()} {path.stat().st_size} {path.name}\n'
            (cache / 'fixture_1.0-1.dsc').write_text(dsc)
            identities = {c: dict(package='fixture-dev', version='1.0-1', source='fixture', sourceVersion='1.0-1') for c in deps.COMPONENTS}
            for suffix in ['orig.tar.gz', 'debian.tar.gz']:
                old_name = 'fixture_1.0' + ('.' if suffix.startswith('orig') else '-1.') + suffix
                new_name = 'header-fixture_2.0' + ('.' if suffix.startswith('orig') else '-1.') + suffix
                shutil.copyfile(cache / old_name, cache / new_name)
            header_dsc = dsc.replace('Source: fixture\n', 'Source: header-fixture\n').replace('Version: 1.0-1\n', 'Version: 2.0-1\n').replace('fixture_1.0', 'header-fixture_2.0')
            (cache / 'header-fixture_2.0-1.dsc').write_text(header_dsc)
            for component, suffix in deps.CXX_HEADERS.items():
                identities[component] = dict(package='header-fixture-dev', version='2.0-1',
                    source='header-fixture', sourceVersion='2.0-1', header='/selected/include/' + suffix)
            with patch.object(deps, 'identities', return_value=identities):
                deps.sources(root / 'inputs', cache)
            deps.reconstruct(root / 'inputs', root / 'unpacked')
            for component in identities:
                self.assertEqual((root / 'unpacked' / component / 'input.h').read_text(), 'distribution-patched\n')
            collected = json.loads((root / 'inputs' / 'inputs.json').read_text())
            self.assertEqual(collected['stdc++']['sourceVersion'], '1.0-1')
            self.assertEqual(collected['stdc++-headers']['sourceVersion'], '2.0-1')
            self.assertEqual((root / 'inputs/stdc++-headers/header-fixture_2.0.orig.tar.gz').stat().st_ino, (root / 'inputs/stdc++-config/header-fixture_2.0.orig.tar.gz').stat().st_ino)
            self.assertEqual(deps.source_components([]), {'eigen', 'stdc++-headers', 'stdc++-config'})
            self.assertIn('gcc', deps.source_components(['libgcc_s.so.1']))
            del collected['stdc++-config']
            (root / 'inputs' / 'inputs.json').write_text(json.dumps(collected))
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                deps.reconstruct(root / 'inputs', root / 'missing-header-output')
            collected['stdc++-config'] = identities['stdc++-config']
            (root / 'inputs' / 'inputs.json').write_text(json.dumps(collected))
            (root / 'inputs' / 'boost' / 'fixture_1.0.orig.tar.gz').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'Corrupt'):
                deps.reconstruct(root / 'inputs', root / 'corrupt-output')

    @unittest.skipUnless(shutil.which('dpkg-query') and shutil.which(os.environ.get('CXX', 'g++')), 'requires Debian C++ toolchain')
    def test_real_linux_compiler_header_owners(self):
        deps = module('linux-dependencies')
        compiler = os.environ.get('CXX', 'g++')
        paths = deps.cxx_headers(compiler)
        output = subprocess.check_output([compiler, '-E', '-x', 'c++', '-'],
                                         input='#include <vector>\n', text=True)
        for component, suffix in deps.CXX_HEADERS.items():
            header = paths[component]
            self.assertIn('"' + header + '"', output)
            self.assertTrue(header.endswith('/' + suffix))
            package = deps.owner(header)
            self.assertEqual(package, subprocess.check_output(
                ['dpkg-query', '-S', header], text=True).strip().split(': /')[0])
            fields = deps.run('dpkg-query', '-W', '-f=${source:Package}\t${source:Version}', package).split('\t')
            self.assertEqual(len(fields), 2)
            self.assertTrue(all(fields))

    def test_explicit_ref_build_uses_unique_run_attempt_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            curl = root / 'curl'
            calls = root / 'calls'
            curl.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CALLS\"\nprintf '%s\\n' '{\"sha\":\"" + 'b'*40 + "\"}'\n")
            curl.chmod(0o755)
            outputs = root / 'outputs'
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       CALLS=str(calls), GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2',
                       GITHUB_OUTPUT=str(outputs), TRACEMAKER_PIN_FILE=str(root / 'absent-pin.json'))
            def resolve(*refs):
                return subprocess.run(['bash', str(ROOT / 'resolve-upstream.sh'), *refs],
                                      env=env, capture_output=True, text=True)
            for ref in [(), ('',), ('   ',)]:
                result = resolve(*ref)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('explicit upstream tag or commit is required', result.stderr)
            self.assertFalse(calls.exists(), 'empty input must fail before any network lookup')
            result = resolve('v1.0.0')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('release_tag=tracemaker-v1.0.0-bbbbbbb-b123-2', result.stdout)
            self.assertIn('upstream_commit=' + 'b'*40, outputs.read_text())
            env['GITHUB_RUN_ATTEMPT'] = '3'
            self.assertIn('release_tag=tracemaker-v1.0.0-bbbbbbb-b123-3', resolve('v1.0.0').stdout)
            self.assertIn('release_tag=tracemaker-bbbbbbb-b123-3', resolve('b'*40).stdout)
            self.assertNotIn('releases/latest', calls.read_text())
            self.assertEqual(calls.read_text().count('/commits/'), 3)

    def test_workflow_is_manual_without_pin_pr_path(self):
        workflow = (ROOT.parents[1] / '.github/workflows/tracemaker-binaries.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotIn('schedule:', workflow)
        self.assertNotIn('open-pin-pr', workflow)
        self.assertNotIn('pull-requests: write', workflow)
        self.assertNotIn('validate-pin:', workflow)
        self.assertNotIn('report-pin:', workflow)
        self.assertFalse((ROOT / 'open-pin-pr.sh').exists())
        self.assertNotIn('build-windows:', workflow)
        self.assertIn('default: false', workflow)
        self.assertIn('inputs.publish &&', workflow)
        for job in ['publish', 'mirror']:
            # Extract the entire job without mistaking nested indentation.
            import re
            section = re.split(r'\n  [a-z][a-z-]*:', workflow.split('\n  ' + job + ':', 1)[1])[0]
            self.assertIn("needs.build-linux.result == 'success' && needs.build-macos.result == 'success'", section)
            self.assertIn('inputs.publish', section)
        for script in ['publish.sh', 'mirror-public.sh']:
            text = (ROOT / script).read_text()
            self.assertNotIn('gh release create tracemaker-latest', text)
            self.assertNotIn('gh release delete tracemaker-latest', text)
            self.assertNotIn('/tracemaker-latest/manifest.json', text)


    def test_storage_lookup_error_cannot_write(self):
        s3 = module('s3-put')
        with patch.object(s3.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('url', 503, 'unavailable', {}, None)) as request:
            with self.assertRaises(SystemExit):
                s3.main_args(['--file', __file__, '--bucket', 'bucket', '--key', 'existing',
                              '--endpoint', 'https://example.test', '--access-key', 'test',
                              '--secret-key', 'test', '--check-absent'])
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[0].method, 'HEAD')

    def test_existing_storage_object_cannot_write(self):
        s3 = module('s3-put')
        with patch.object(s3.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value.status = 200
            with self.assertRaises(SystemExit):
                s3.main_args(['--file', __file__, '--bucket', 'bucket', '--key', 'existing',
                              '--endpoint', 'https://example.test', '--access-key', 'test',
                              '--secret-key', 'test', '--check-absent'])
            self.assertEqual(request.call_count, 1)

    def test_immutable_put_is_conditional(self):
        s3 = module('s3-put')
        with patch.object(s3.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value.status = 200
            s3.main_args(['--file', __file__, '--bucket', 'bucket', '--key', 'new',
                          '--endpoint', 'https://example.test', '--access-key', 'test',
                          '--secret-key', 'test', '--create-only'])
            self.assertEqual(request.call_args.args[0].get_header('If-none-match'), '*')

if __name__ == '__main__':
    unittest.main()
