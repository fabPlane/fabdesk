#!/usr/bin/env python3
"""Resolve an exact public Release run to its tag; otherwise use run artifacts."""
import base64
import json
import re
import subprocess
import sys

REPO = 'TensorFleet/fabdesk'


def github(path, missing_ok=False):
    result = subprocess.run(['gh', 'api', 'repos/' + REPO + '/' + path], capture_output=True, text=True)
    if result.returncode:
        try:
            missing = str(json.loads(result.stdout).get('status')) == '404'
        except (ValueError, AttributeError):
            missing = False
        if missing_ok and missing:
            return None
        raise RuntimeError('GitHub API request failed: ' + path + ': ' + result.stderr.strip())
    return json.loads(result.stdout)


def resolve(run_id, fetch=github):
    if not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise ValueError('release run ID must be a positive integer')
    run = fetch('actions/runs/' + run_id)
    if run['head_branch'] != 'main':
        return None
    package = fetch('contents/package.json?ref=' + run['head_sha'])
    version = json.loads(base64.b64decode(package['content']))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+].*)?', version):
        raise ValueError('invalid package version at release commit')
    tag = 'v' + '.'.join(version.split('.')[:2]) + '.' + str(run['run_number'])
    release = fetch('releases/tags/' + tag, missing_ok=True)
    if release is None or release['draft']:
        return None  # Internal/branch builds continue to use exact run artifacts.
    if release['tag_name'] != tag or release['target_commitish'] != run['head_sha']:
        raise ValueError('published release does not match the requested workflow commit')
    return tag


if __name__ == '__main__':
    try:
        print(resolve(sys.argv[1]) or '')
    except Exception as error:
        print('Cannot resolve exact release: ' + str(error), file=sys.stderr)
        sys.exit(1)
