#!/usr/bin/env bash
# Collect licenses from the exact installed build dependencies, fail if absent.
set -euo pipefail
platform="${1:?}"; dest="${2:?}"; runtime="${3:-system}"
mkdir -p "$dest"
case "$platform" in
  linux-*)
    python3 "$(dirname "$0")/linux-dependencies.py" licenses "$dest"
    ;;
  windows-*)
    # Package splits change (gcc-libs vs libgcc/libstdc++, sqlite vs
    # sqlite3). Retain all installed notices, using the package manager's own
    # installed tree, so DLL dependencies such as winpthreads are covered too.
    test -d /ucrt64/share/licenses
    cp -RL /ucrt64/share/licenses "$dest/msys2"
    ;;
  macos-*)
    packages=(zstd boost eigen cli11 nlohmann-json)
    if [[ "${TRACEMAKER_LINK_NOTE:-}" == *libsqlite3.a* ]]; then
      # SQLite headers carry the copyright disclaimer and blessing. The
      # canonical notice need not contain the literal words "public domain".
      mkdir -p "$dest/sqlite"
      python3 - "$(brew --prefix sqlite)/include/sqlite3.h" "$dest/sqlite/NOTICE.txt" <<'PYSQLITE'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
notice = text[:text.index('*/') + 2]
if not any(marker in notice.lower() for marker in ['public domain', 'the author disclaims copyright to this source code']):
    raise ValueError('SQLite copyright disclaimer/public-domain notice missing')
Path(sys.argv[2]).write_text(notice + '\n')
PYSQLITE
    fi
    if [ "$runtime" = llvm-static ]; then packages+=(llvm); fi
    for package in "${packages[@]}"; do
      # Homebrew installs do not consistently retain license files. Its verified
      # source bottle input supplies the exact formula version's texts instead.
      brew info --json=v2 "$package" | python3 -c 'import json,sys; f=json.load(sys.stdin)["formulae"][0]; assert f["installed"] and all(i["version"].split("_")[0] == f["versions"]["stable"] for i in f["installed"]), "Installed formula differs from source version"'
      brew fetch --build-from-source "$package"
      archive="$(brew --cache --build-from-source "$package")"
      work="$(mktemp -d "${TMPDIR:-/tmp}/tm-license.XXXXXX")"
      tar -xf "$archive" -C "$work"
      mkdir -p "$dest/$package"
      python3 - "$work" "$dest/$package" <<'PYLICENSE'
from pathlib import Path
import shutil, sys
root, dest = map(Path, sys.argv[1:])
for path in root.rglob('*'):
    if path.is_file() and any(word in path.name.lower() for word in ['license', 'copying', 'copyright']):
        target = dest / path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
PYLICENSE
      test -n "$(ls -A "$dest/$package")" || { echo "No licenses in $archive" >&2; exit 1; }
      rm -rf "$work"
    done
    # macOS system SQLite/libc++ are OS libraries; no copy is bundled.
    ;;
  *) echo "Unknown license platform $platform" >&2; exit 1;;
esac
