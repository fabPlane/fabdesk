#!/usr/bin/env bash
# Fail closed if installed package versions cannot be recovered. Never substitute
# newer dependency sources. Output becomes part of the immutable source bundle.
set -euo pipefail
platform="${1:?}"; dest="${2:?}"; runtime="${3:-system}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
case "$platform" in
  linux-*)
    args=()
    if [ -n "${TRACEMAKER_APT_SOURCE_CACHE:-}" ]; then args+=(--cache "$TRACEMAKER_APT_SOURCE_CACHE"); fi
    python3 "$(dirname "$0")/linux-dependencies.py" sources "$dest" "${args[@]}"
    ;;
  macos-*)
    # Eigen MPL headers are compiled in. Boost/CLI11/nlohmann/zstd/LLVM
    # use permissive licenses; SQLite is public domain. Keep their notices.
    packages=(eigen)
    for package in "${packages[@]}"; do
      mkdir -p "$dest/$package"
      brew info --json=v2 "$package" > "$dest/$package/identity.json"
      python3 - "$dest/$package/identity.json" <<'PY'
import json, sys
f = json.load(open(sys.argv[1]))['formulae'][0]
assert f['installed'] and all(i['version'] == (f['versions']['stable'] + ('_' + str(f['revision']) if f['revision'] else '')) for i in f['installed']), 'Installed formula differs from recipe; refuse mismatched sources'
PY
      brew cat "$package" > "$dest/$package/recipe.rb"
      brew fetch --build-from-source "$package"
      cp "$(brew --cache --build-from-source "$package")" "$dest/$package/"
      # Keep patched source too: unpack fetches and applies formula patches.
      brew unpack --patch --destdir="$dest/$package/patched" "$package"
    done
    ;;
  windows-*)
    # Recover the exact MSYS2 packaging revision for each installed dependency.
    # --allsource includes downloaded upstream sources AND local distro patches.
    recipes="$(mktemp -d "${TMPDIR:-/tmp}/tm-msys-sources.XXXXXX")"
    trap 'rm -rf "$recipes"' EXIT
    git clone --filter=blob:none https://github.com/msys2/MINGW-packages.git "$recipes/repo"
    for component in boost eigen3 cli11 nlohmann-json zstd sqlite3 gcc winpthreads; do
      package="mingw-w64-ucrt-x86_64-$component"
      version="$(pacman -Q "$package" | awk '{print $2}')"
      recipe="mingw-w64-$component"
      target="$dest/$component"
      mkdir -p "$target"
      pacman -Qi "$package" > "$target/identity.txt"
      found=false
      while read -r commit; do
        git -C "$recipes/repo" archive "$commit" "$recipe" | tar -x -C "$recipes"
        if (cd "$recipes/$recipe" && makepkg --printsrcinfo) > "$target/srcinfo" && \
          python3 - "$target/srcinfo" "$version" <<'PY'
import sys
fields = {}
for line in open(sys.argv[1]):
    if '=' in line:
        key, value = map(str.strip, line.split('=', 1)); fields[key] = value
version = fields['pkgver'] + '-' + fields['pkgrel']
if fields.get('epoch', '0') != '0': version = fields['epoch'] + ':' + version
sys.exit(0 if version == sys.argv[2] else 1)
PY
        then
          (cd "$recipes/$recipe" && makepkg --allsource --noconfirm)
          cp "$recipes/$recipe/"*.src.tar.* "$target/"
          echo "$commit" > "$target/packaging-commit.txt"
          found=true
          break
        fi
        rm -rf "$recipes/$recipe"
      done < <(git -C "$recipes/repo" log --format=%H -- "$recipe/PKGBUILD")
      $found || { echo "Cannot recover sources for $package=$version" >&2; exit 1; }
      rm -rf "$recipes/$recipe"
    done
    ;;
  *) exit 1;;
esac
python3 - "$dest" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
files = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}
(root / 'SHA256.json').write_text(json.dumps(files, indent=2) + '\n')
PY
