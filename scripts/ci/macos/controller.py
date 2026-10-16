#!/usr/bin/env python3
"""Keep all repository listeners connected inside one shared Mac VM."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time

HOME = Path.home()
STATE = Path(os.environ.get('MAC_RUNNER_STATE_DIR', str(HOME / 'ephemeral-runner')))
CONFIG = json.loads((STATE / 'shared-config.json').read_text())
TART = str(HOME / '.local/bin/tart')
VM = CONFIG.get('vm', 'github-runner-shared')
BASE = CONFIG.get('base', 'macos-ci-golden')
REPOS = CONFIG['repositories']
STOP = False


def log(message):
    with (STATE / 'shared-controller.log').open('a') as stream:
        stream.write(time.strftime('%Y-%m-%dT%H:%M:%SZ ', time.gmtime()) + message + '\n')


def command(*args, timeout=60, check=True, **kwargs):
    return subprocess.run(args, timeout=timeout, check=check, **kwargs)


def guest(script, timeout=30, check=True):
    return command(TART, 'exec', VM, '/bin/bash', '-lc', script,
                   timeout=timeout, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def stop(_signum, _frame):
    global STOP
    STOP = True


def start_listener(repo):
    folder = '/Users/admin/actions-runners/' + repo
    hooks = '/Users/admin/runner-hooks'
    script = ('cd ' + shlex.quote(folder) + '; nohup env MAC_RUNNER_REPO_KEY=' + shlex.quote(repo)
              + ' ACTIONS_RUNNER_HOOK_JOB_STARTED=' + hooks + '/started.sh'
              + ' ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' + hooks + '/completed.sh'
              + ' ./run.sh > ' + shlex.quote(folder + '/listener.log') + ' 2>&1 < /dev/null &')
    guest(script)
    log('listener started: ' + repo)


def prepare():
    command(TART, 'stop', VM, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    command(TART, 'delete', VM, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    command(TART, 'clone', BASE, VM)
    command(TART, 'set', VM, '--cpu', str(CONFIG.get('cpu', 6)), '--memory', str(CONFIG.get('memory_mib', 10240)))
    output = (STATE / 'shared-tart.log').open('a')
    proc = subprocess.Popen([TART, 'run', '--no-graphics', '--no-audio', '--no-clipboard', VM], stdout=output, stderr=output)
    for _ in range(120):
        if STOP or proc.poll() is not None:
            raise RuntimeError('VM stopped before readiness')
        try:
            guest('true', timeout=5)
            break
        except (subprocess.SubprocessError, OSError):
            time.sleep(2)
    else:
        raise RuntimeError('VM guest agent did not become ready')
    guest('mkdir -p /Users/admin/actions-runners /Users/admin/runner-hooks')
    for repo in REPOS:
        folder = '/Users/admin/actions-runners/' + repo
        guest('mkdir -p ' + shlex.quote(folder))
        archive = subprocess.Popen(['tar', '--exclude=./_work', '--exclude=./_diag', '--exclude=./.service',
                                    '-C', str(HOME / 'actions-runners' / repo), '-cf', '-', '.'], stdout=subprocess.PIPE)
        command(TART, 'exec', '-i', VM, '/usr/bin/tar', '-xf', '-', '-C', folder, stdin=archive.stdout, timeout=120)
        archive.stdout.close()
        if archive.wait() != 0:
            raise RuntimeError('Runner archive failed: ' + repo)
    archive = subprocess.Popen(['tar', '-C', str(STATE / 'shared-hooks'), '-cf', '-', '.'], stdout=subprocess.PIPE)
    command(TART, 'exec', '-i', VM, '/usr/bin/tar', '-xf', '-', '-C', '/Users/admin/runner-hooks', stdin=archive.stdout)
    archive.stdout.close()
    if archive.wait() != 0:
        raise RuntimeError('Hook archive failed')
    guest('chmod 700 /Users/admin/runner-hooks/*.sh /Users/admin/runner-hooks/*.py')
    for repo in REPOS:
        start_listener(repo)
    return proc


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not STOP:
        proc = None
        try:
            proc = prepare()
            failures = 0
            while not STOP and proc.poll() is None:
                time.sleep(10)
                try:
                    for repo in REPOS:
                        pattern = '/Users/admin/actions-runners/' + repo + '/bin/[R]unner.Listener'
                        result = guest('pgrep -f ' + shlex.quote(pattern) + ' >/dev/null', check=False)
                        if result.returncode:
                            start_listener(repo)
                    failures = 0
                except (subprocess.SubprocessError, OSError) as error:
                    failures += 1
                    log('guest check failure: ' + type(error).__name__)
                    if failures >= 12:
                        raise RuntimeError('Guest stayed unresponsive')
        except (subprocess.SubprocessError, OSError, RuntimeError) as error:
            log('controller recovery: ' + type(error).__name__)
            if not STOP:
                time.sleep(15)
        finally:
            command(TART, 'stop', VM, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if proc:
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.terminate()
    log('controller stopped')


if __name__ == '__main__':
    main()
