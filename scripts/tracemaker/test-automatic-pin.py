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

class AutomaticPin(unittest.TestCase):
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

    def test_mirror_lookup_failure_preserves_existing_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            scripts = root / 'scripts'
            shutil.copytree(ROOT, scripts)
            artifacts = root / 'artifacts'
            artifacts.mkdir()
            (artifacts / 'new.tar.gz').write_bytes(b'rebuilt bytes')
            (artifacts / 'manifest.json').write_text(json.dumps({'assets': [{
                'filename': 'new.tar.gz', 'sha256': 'a'*64, 'url': 'https://example.test/file'}]}))
            existing = root / 'existing.tar.gz'
            existing.write_bytes(b'original immutable bytes')
            log = root / 'calls'
            # The authoritative store rejects HEAD (503); public GET would also
            # fail, as in F45-2. Any attempted PUT would destroy the fixture.
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

    def test_archive_requires_every_bundled_library_license(self):
        checker = module('check-archive')
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'binary.tar.gz'
            names = ['LICENSE', 'NOTICE', 'SOURCE.txt', 'DEPENDENCIES.txt',
                     'corresponding-source/upstream.tar.gz', 'corresponding-source/build.patch',
                     'tracemaker', 'tracemaker-place']
            data = {name: b'x' for name in names}
            def pack():
                with tarfile.open(archive, 'w:gz') as tar:
                    for name, body in data.items():
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
            for component in sorted(deps.COMPONENTS):
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
            checker.check_archive(archive, asset)
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

    def test_newest_release_build_and_complete_pin_skip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            curl = root / 'curl'
            curl.write_text("#!/bin/sh\ncase \"$*\" in *releases/latest*) echo '{\"tag_name\":\"v1.0.0\"}';; *) echo '{\"sha\":\"" + 'b'*40 + "\"}';; esac\n")
            curl.chmod(0o755)
            pin = root / 'pin.json'
            candidate = {'upstream': {'tag': 'v0.12.1', 'commit': 'a'*40}, 'assets': []}
            pin.write_text(json.dumps(candidate))
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       TRACEMAKER_PIN_FILE=str(pin), GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2', TRACEMAKER_FORCE='false')
            def resolve():
                return subprocess.run(['bash', str(ROOT / 'resolve-upstream.sh')], env=env, capture_output=True, text=True, check=True).stdout
            output = resolve()
            self.assertIn('release_tag=tracemaker-v1.0.0-bbbbbbb-b123-2', output)
            self.assertIn('skip=false', output)
            candidate['upstream'] = {'tag': 'v1.0.0', 'commit': 'b'*40}
            candidate['assets'] = [{'platform': p, 'placer': 'tracemaker-place'} for p in ['linux-x86_64', 'macos-arm64', 'windows-x86_64']]
            pin.write_text(json.dumps(candidate))
            self.assertIn('skip=true', resolve())

    def test_open_pr_exposes_exact_pushed_commit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            remote = root / 'origin.git'
            subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
            repo = root / 'repo'; repo.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
            git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
            shutil.copytree(ROOT, repo / 'scripts/tracemaker')
            pin = repo / 'packages/tools/src/routers/tracemaker-pin.json'; pin.parent.mkdir(parents=True); pin.write_text('{}')
            git('add', '.'); git('commit', '-m', 'base'); git('remote', 'add', 'origin', str(remote)); git('push', 'origin', 'main')
            candidate = root / 'candidate.json'
            candidate.write_text(json.dumps({'assets': [{'platform': p, 'placer': 'tracemaker-place',
                'sha256': 'a'*64, 'url': 'https://downloads.fabplane.com/tracemaker/build/file'}
                for p in ['linux-x86_64', 'macos-arm64']]}))
            bin_dir = root / 'bin'; bin_dir.mkdir()
            gh = bin_dir / 'gh'
            gh.write_text('#!/bin/sh\ncase "$*" in "pr list"*) echo 7;; esac\n')
            gh.chmod(0o755)
            output = root / 'output'
            subprocess.run(['bash', 'scripts/tracemaker/open-pin-pr.sh', str(candidate)], cwd=repo,
                env=dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], GITHUB_OUTPUT=str(output)), check=True, capture_output=True)
            fields = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(fields['sha'], git('rev-parse', 'HEAD'))
            self.assertEqual(fields['sha'], git('ls-remote', 'origin', 'refs/heads/automation/tracemaker-pin').split()[0])
            self.assertEqual(fields['pr'], '7')
            self.assertEqual(pin.read_bytes(), candidate.read_bytes())
            # Reusable CI must check out that input in all three code jobs.
            ci = (ROOT.parents[1] / '.github/workflows/ci.yml').read_text()
            self.assertEqual(ci.count('ref: ${{ inputs.ref || github.sha }}'), 3)
            workflow = (ROOT.parents[1] / '.github/workflows/tracemaker-binaries.yml').read_text()
            self.assertIn('ref: ${{ needs.mirror.outputs.sha }}', workflow)
            self.assertIn('head_sha: sha', workflow)

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
