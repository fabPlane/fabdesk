import base64
import importlib.util
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resolver', Path(__file__).parents[1] / 'resolve-run-release.py')
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class ResolveTests(unittest.TestCase):
    def test_download_source_defaults_to_new_repository(self):
        with patch.dict(os.environ, {}, clear=True):
            module = runpy.run_path(str(Path(__file__).parents[1] / 'resolve-run-release.py'))
        self.assertEqual(module['REPO'], 'fabPlane/fabdesk')

    def test_actions_checkout_selects_its_own_repository(self):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'company/preview'}, clear=True):
            module = runpy.run_path(str(Path(__file__).parents[1] / 'resolve-run-release.py'))
        self.assertEqual(module['REPO'], 'company/preview')

    def test_explicit_override_can_still_test_a_historical_release(self):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'fabPlane/fabdesk', 'FABDESK_VM_REPO': 'TensorFleet/fabdesk'}, clear=True):
            module = runpy.run_path(str(Path(__file__).parents[1] / 'resolve-run-release.py'))
        self.assertEqual(module['REPO'], 'TensorFleet/fabdesk')

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


class PreviousReleaseTests(unittest.TestCase):
    releases = [
        dict(tag_name='v0.4.25', draft=True, prerelease=False),
        dict(tag_name='v0.4.24', draft=False, prerelease=False),
        dict(tag_name='v0.4.23', draft=True, prerelease=False),
        dict(tag_name='v0.4.22', draft=False, prerelease=True),
        dict(tag_name='v0.4.21', draft=False, prerelease=False),
        dict(tag_name='v0.4.19', draft=False, prerelease=False),
        dict(tag_name='cli-v1.2.0', draft=False, prerelease=False),
    ]

    def fetch(self, path, missing_ok=False):
        self.assertEqual(path, 'releases?per_page=100')
        return self.releases

    def test_newest_published_release_before_the_tag(self):
        self.assertEqual(resolver.previous('v0.4.25', self.fetch), 'v0.4.24')

    def test_drafts_and_prereleases_are_not_what_users_run(self):
        self.assertEqual(resolver.previous('v0.4.24', self.fetch), 'v0.4.21')

    def test_versions_compare_as_numbers(self):
        releases = [dict(tag_name='v0.4.99', draft=False, prerelease=False), dict(tag_name='v0.4.100', draft=False, prerelease=False)]
        self.assertEqual(resolver.previous('v0.4.101', lambda *a, **k: releases), 'v0.4.100')

    def test_releases_before_in_place_updates_are_skipped(self):
        self.assertIsNone(resolver.previous('v0.4.21', self.fetch))

    def test_invalid_tag(self):
        with self.assertRaises(ValueError):
            resolver.previous('latest', self.fetch)


if __name__ == '__main__':
    unittest.main()
