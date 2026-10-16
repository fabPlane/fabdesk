import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('job_hook', Path(__file__).parents[1] / 'job-hook.py')
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        HOOK.ROOT = self.home / 'runner-hooks'
        HOOK.STATE = HOOK.ROOT / 'active-job.json'
        HOOK.GUARD = HOOK.ROOT / 'active-job.guard'
        HOOK.ROOT.mkdir()
        self.environment = patch.dict(os.environ, {'MAC_RUNNER_REPO_KEY': 'repo', 'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1'})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temp.cleanup()

    def run_hook(self, mode):
        with patch.object(HOOK.sys, 'argv', ['hook', mode]), patch.object(HOOK.Path, 'home', return_value=self.home), patch.object(HOOK, 'worker_pid', return_value=123):
            HOOK.main()

    def test_claim_and_release_clean_only_this_workspace(self):
        workspace = self.home / 'actions-runners/repo/_work/repo/repo'
        workspace.mkdir(parents=True)
        (workspace / 'file').write_text('checkout')
        os.environ['GITHUB_WORKSPACE'] = str(workspace)
        self.run_hook('started')
        self.assertEqual(json.loads(HOOK.STATE.read_text())['owner'], 'repo:42:1')
        self.run_hook('completed')
        self.assertFalse(HOOK.STATE.exists())
        self.assertFalse(workspace.exists())

    def test_dead_owner_is_reclaimed(self):
        HOOK.STATE.write_text(json.dumps({'owner':'old:1:1','pid':999}))
        with patch.object(HOOK, 'alive', return_value=False):
            self.run_hook('started')
        self.assertEqual(json.loads(HOOK.STATE.read_text())['pid'], 123)

    def test_foreign_owner_and_unrelated_directory_are_preserved(self):
        HOOK.STATE.write_text(json.dumps({'owner':'other:99:1','pid':999}))
        keep = self.home / 'keep'
        keep.mkdir()
        os.environ['GITHUB_WORKSPACE'] = str(keep)
        self.run_hook('completed')
        self.assertEqual(json.loads(HOOK.STATE.read_text())['owner'], 'other:99:1')
        self.assertTrue(keep.exists())


if __name__ == '__main__':
    unittest.main()
