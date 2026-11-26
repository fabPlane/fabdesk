#!/usr/bin/env python3
"""Resolve an exact public Release run to its tag; otherwise use run artifacts.

  resolve-run-release.py <run id>          the public tag that run published, or nothing
  resolve-run-release.py --previous vX.Y.Z the public release to test an in-place update from
"""
import base64
import json
import os
import re
import subprocess
import sys

REPO = os.environ.get('FABDESK_VM_REPO') or os.environ.get('GITHUB_REPOSITORY') or 'fabPlane/fabdesk'


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


# The first release whose app can replace itself; older ones only download an installer.
FIRST_IN_PLACE = (0, 4, 21)


def version_of(tag):
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', tag or '')
    return tuple(int(part) for part in match.groups()) if match else None


def previous(tag, fetch=github):
    """The newest published release older than `tag` that updates in place, or None."""
    current = version_of(tag)
    if current is None:
        raise ValueError('release tag must look like vX.Y.Z')
    older = [
        (version_of(release['tag_name']), release['tag_name'])
        for release in fetch('releases?per_page=100')
        if not release['draft'] and not release['prerelease'] and version_of(release['tag_name'])
    ]
    older = [entry for entry in older if FIRST_IN_PLACE <= entry[0] < current]
    return max(older)[1] if older else None


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--previous':
            print(previous(sys.argv[2]) or '')
        else:
            print(resolve(sys.argv[1]) or '')
    except Exception as error:
        print('Cannot resolve exact release: ' + str(error), file=sys.stderr)
        sys.exit(1)
