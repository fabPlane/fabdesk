#!/usr/bin/env python3
"""Serialize shared Mac jobs, reclaim stale owners, and clean per-repo workspaces."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path.home() / 'runner-hooks'
STATE = ROOT / 'active-job.json'
GUARD = ROOT / 'active-job.guard'


def worker_pid():
    pid = os.getppid()
    for _ in range(20):
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'comm='], text=True).strip()
        if 'Runner.Worker' in command:
            return pid
        pid = int(subprocess.check_output(['ps', '-p', str(pid), '-o', 'ppid='], text=True).strip())
        if pid <= 1:
            break
    raise RuntimeError('Cannot identify the runner worker; refusing to bypass the shared lock')


def alive(pid):
    try:
        os.kill(int(pid), 0)
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'comm='], text=True).strip()
        return 'Runner.Worker' in command
    except (OSError, ValueError, subprocess.CalledProcessError):
        return False


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    key = os.environ['MAC_RUNNER_REPO_KEY']
    owner = ':'.join([key, os.environ.get('GITHUB_RUN_ID', ''), os.environ.get('GITHUB_RUN_ATTEMPT', '')])
    start = sys.argv[1] == 'started'
    pid = worker_pid() if start else None
    deadline = time.monotonic() + 7200
    while True:
        with GUARD.open('a') as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            try:
                state = json.loads(STATE.read_text())
            except (OSError, ValueError):
                state = {}
            if not start:
                if state.get('owner') == owner:
                    STATE.unlink(missing_ok=True)
                break
            if not state or not alive(state.get('pid')):
                STATE.write_text(json.dumps({'owner': owner, 'pid': pid, 'started_at': int(time.time())}))
                STATE.chmod(0o600)
                return
        if time.monotonic() >= deadline:
            raise RuntimeError('Shared Mac job lock timed out')
        time.sleep(2)
    workspace = Path(os.environ.get('GITHUB_WORKSPACE', '/')).resolve()
    work_root = (Path.home() / 'actions-runners' / key / '_work').resolve()
    if work_root in workspace.parents:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == '__main__':
    main()
