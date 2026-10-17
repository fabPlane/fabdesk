import base64
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('resolver', Path(__file__).parents[1] / 'resolve-run-release.py')
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class ResolveTests(unittest.TestCase):
    def fetch(self, path, missing_ok=False):
        if path.startswith('actions/runs/'):
            return dict(head_branch=self.branch, head_sha='a' * 40, run_number=158)
        if path.startswith('contents/'):
            self.assertIn('ref=' + 'a' * 40, path)
            return dict(content=base64.b64encode(b'{"version":"0.2.0"}').decode())
        self.assertEqual(path, 'releases/tags/v0.2.158')
        self.assertTrue(missing_ok)
        return self.release

    def setUp(self):
        self.branch = 'main'
        self.release = dict(draft=False, tag_name='v0.2.158', target_commitish='a' * 40)

    def test_public_run_selects_exact_tag(self):
        self.assertEqual(resolver.resolve('123', self.fetch), 'v0.2.158')

    def test_internal_without_release_uses_artifacts(self):
        self.release = None
        self.assertIsNone(resolver.resolve('123', self.fetch))

    def test_branch_run_uses_artifacts(self):
        self.branch = 'feature'
        self.assertIsNone(resolver.resolve('123', self.fetch))

    def test_draft_is_not_a_public_installer_source(self):
        self.release['draft'] = True
        self.assertIsNone(resolver.resolve('123', self.fetch))

    def test_wrong_commit_is_rejected(self):
        self.release['target_commitish'] = 'b' * 40
        with self.assertRaises(ValueError):
            resolver.resolve('123', self.fetch)

    def test_api_failure_does_not_fall_back_to_other_installers(self):
        def denied(*args, **kwargs):
            raise RuntimeError('HTTP 403')
        with self.assertRaises(RuntimeError):
            resolver.resolve('123', denied)

    def test_invalid_run_id(self):
        with self.assertRaises(ValueError):
            resolver.resolve('latest', self.fetch)


if __name__ == '__main__':
    unittest.main()
