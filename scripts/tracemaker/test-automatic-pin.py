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
            def pack():
                with tarfile.open(archive, 'w:gz') as tar:
                    for name in names:
                        info = tarfile.TarInfo(name)
                        info.size = 1
                        tar.addfile(info, io.BytesIO(b'x'))
            asset = {'platform': 'linux-x86_64', 'executable': 'tracemaker', 'placer': 'tracemaker-place'}
            pack()
            with self.assertRaises(ValueError): checker.check_archive(archive, asset)
            names += ['licenses/' + c + '.txt' for c in ['zstd', 'sqlite', 'gcc', 'boost', 'eigen', 'cli11', 'nlohmann']]
            pack()
            checker.check_archive(archive, asset)

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
