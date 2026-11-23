#!/usr/bin/env python3
"""Publish shared capacity using the monitor host's existing GitHub authentication."""
import json
import subprocess
import time

REPOSITORIES = ('fabPlane/fabdesk', 'fabPlane/fab_pcb', 'TensorFleet/js_autorouter')


def api(path, method='GET', body=None):
    command = ['gh', 'api', path, '--method', method]
    if body is not None:
        command += ['--input', '-']
    return json.loads(subprocess.check_output(command, input=json.dumps(body).encode() if body else None) or '{}')


def main():
    ready = True
    for repo in REPOSITORIES:
        runners = api(f'repos/{repo}/actions/runners?per_page=100')['runners']
        mac = [r for r in runners if r['name'].startswith('macos-runner-1-')]
        ready = ready and len(mac) == 1 and mac[0]['status'] == 'online' and not mac[0]['busy']
    value = str(int(time.time())) if ready else '0'
    for repo in REPOSITORIES:
        api(f'repos/{repo}/actions/variables/MAC_RUNNER_HEARTBEAT', 'PATCH', {'name': 'MAC_RUNNER_HEARTBEAT', 'value': value})
    print('Shared Mac capacity:', 'idle' if ready else 'busy or unavailable')


if __name__ == '__main__':
    main()
