#!/usr/bin/env bash
# Local checks for the release scripts. Does not compile TraceMaker and does
# not call api.fabplane.com or GitHub Releases (gh is mocked).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tm-script-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
fail=0

assert_eq() {
  local got="$1" want="$2" msg="$3"
  if [ "$got" != "$want" ]; then
    echo "FAIL $msg"
    echo "  got:  $got"
    echo "  want: $want"
    fail=1
  else
    echo "ok   $msg"
  fi
}

assert_file() {
  if [ ! -f "$1" ]; then
    echo "FAIL missing $1"
    fail=1
  else
    echo "ok   exists $1"
  fi
}

assert_contains() {
  if ! grep -q -- "$2" "$1"; then
    echo "FAIL $1 does not contain: $2"
    fail=1
  else
    echo "ok   $1 contains $2"
  fi
}

# --- absolute path helper ---
rel="$ROOT/workspace/rel-dir"
mkdir -p "$rel"
got="$(abs_existing_dir "$ROOT/workspace/./rel-dir")"
assert_eq "$got" "$rel" "abs_existing_dir resolves ."

# --- build.sh relative src after cd (the linux-x86_64 failure) ---
ws="$ROOT/workspace"
mkdir -p "$ws/TraceMaker" "$ws/fakebin"
cat > "$ws/fakebin/cmake" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --build "* ]]; then
  mkdir -p build/cpu-only/src/app
  printf '#!/bin/sh\nexit 0\n' > build/cpu-only/src/app/tracemaker
  chmod +x build/cpu-only/src/app/tracemaker
  echo "[63/63] Linking CXX executable src/app/tracemaker"
  exit 0
fi
mkdir -p build/cpu-only
echo "-- configured cpu-only in $PWD"
EOF
chmod +x "$ws/fakebin/cmake"
(
  cd "$ws"
  PATH="$ws/fakebin:$PATH" bash "$SCRIPT_DIR/build.sh" TraceMaker linux-x86_64 > "$ROOT/build.out"
)
binary="$(awk -F= '/^binary=/{print $2}' "$ROOT/build.out")"
assert_eq "$binary" "$ws/TraceMaker/build/cpu-only/src/app/tracemaker" "build.sh emits an absolute binary path"
assert_file "$binary"

# --- fake tracemaker CLI for smoke + package ---
fake_bin="$ROOT/bin/tracemaker"
mkdir -p "$ROOT/bin"
cat > "$fake_bin" <<'EOF'
#!/bin/sh
if [ "$1" = "--help" ] || [ "$1" = help ]; then
  echo "tracemaker help"
  exit 0
fi
if [ "$1" = "version" ]; then
  echo "tracemaker 0.9.0"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "A subcommand is required" >&2
  exit 2
fi
if [ "$1" = route ]; then
  out=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "-o" ]; then
      out="$2"
      shift 2
      continue
    fi
    shift
  done
  if [ -z "$out" ]; then
    echo "missing -o" >&2
    exit 2
  fi
  printf '(kicad_pcb (version 20241229))\n' > "$out"
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
EOF
chmod +x "$fake_bin"

# smoke from a different cwd with a relative fixture path
(
  cd "$ROOT"
  bash "$SCRIPT_DIR/smoke.sh" "$fake_bin" "$SCRIPT_DIR/fixtures/smoke.kicad_pcb" "$ROOT/smoke-out" > "$ROOT/smoke.log"
)
assert_file "$ROOT/smoke-out/routed.kicad_pcb"
assert_contains "$ROOT/smoke.log" "smoke ok"
assert_contains "$ROOT/smoke.log" "tracemaker 0.9.0"

# --- package both platforms (relative dest + TRACEMAKER_SRC) ---
src_tree="$ROOT/tm-src"
mkdir -p "$src_tree"
printf 'GPL-3.0-or-later\n' > "$src_tree/LICENSE"
printf 'NOTICE\n' > "$src_tree/NOTICE"
printf 'Applied fabdesk patch 24c847772e57ea8888e2cfe4bbf1aa00666390a4.patch\n' > "$src_tree/.fabdesk-macos-patch"
{
  echo "macOS link: Homebrew LLVM static libc++ / libc++abi / libunwind; -nostdlib++."
  echo "SQLite: isolated headers /tmp/sqlite + /opt/homebrew/opt/sqlite/lib/libsqlite3.a."
  echo "zstd: static /opt/homebrew/opt/zstd/lib/libzstd.a (not Homebrew libzstd.dylib)."
} > "$src_tree/.fabdesk-macos-link"

export TRACEMAKER_UPSTREAM_REPO=DingoOz/TraceMaker
export TRACEMAKER_UPSTREAM_TAG=v0.9.0
export TRACEMAKER_UPSTREAM_COMMIT=24c847772e57ea8888e2cfe4bbf1aa00666390a4
export TRACEMAKER_SOURCE_URL=https://github.com/DingoOz/TraceMaker/archive/24c847772e57ea8888e2cfe4bbf1aa00666390a4.tar.gz
export TRACEMAKER_RELEASE_TAG=tracemaker-v0.9.0-24c8477
export TRACEMAKER_SRC="$src_tree"
export TRACEMAKER_BUILT_AT=2026-10-09T22:00:00Z
export GITHUB_REPOSITORY=TensorFleet/fabdesk

(
  cd "$ROOT"
  bash "$SCRIPT_DIR/package.sh" "$fake_bin" linux-x86_64 pack/linux-x86_64
  bash "$SCRIPT_DIR/package.sh" "$fake_bin" macos-arm64 pack/macos-arm64
)
assert_file "$ROOT/pack/linux-x86_64/asset.json"
assert_file "$ROOT/pack/macos-arm64/asset.json"
assert_file "$ROOT/pack/linux-x86_64/tracemaker-linux-x86_64.tar.gz"
assert_file "$ROOT/pack/macos-arm64/tracemaker-macos-arm64.tar.gz"
assert_contains "$ROOT/pack/macos-arm64/SOURCE.txt" "24c847772e57ea8888e2cfe4bbf1aa00666390a4.patch"
assert_contains "$ROOT/pack/macos-arm64/SOURCE.txt" "libzstd.a"
assert_contains "$ROOT/pack/linux-x86_64/LICENSE" "GPL-3.0-or-later"
assert_file "$ROOT/pack/macos-arm64/DEPENDENCIES.txt"
assert_file "$ROOT/pack/macos-arm64/NOTICE"
assert_contains "$ROOT/pack/macos-arm64/DEPENDENCIES.txt" "static libzstd.a"
assert_contains "$SCRIPT_DIR/package.sh" "shasum -a 256"
tar -tzf "$ROOT/pack/macos-arm64/tracemaker-macos-arm64.tar.gz" > "$ROOT/macos-tar.list"
for _need in tracemaker LICENSE NOTICE SOURCE.txt DEPENDENCIES.txt; do
  if grep -q "${_need}$" "$ROOT/macos-tar.list" || grep -q "/${_need}$" "$ROOT/macos-tar.list"; then
    echo "ok   macos archive contains $_need"
  else
    echo "FAIL macos archive missing $_need"
    echo "  listing:"
    cat "$ROOT/macos-tar.list"
    fail=1
  fi
done
python3 - <<PY
import json, pathlib
mac = json.loads(pathlib.Path("$ROOT/pack/macos-arm64/asset.json").read_text())
assert mac["platform"] == "macos-arm64"
assert mac["format"] == "tar.gz"
assert mac["executable"] == "tracemaker"
assert mac["linkage"] == "system-libc-or-frameworks"
assert mac["minos"] == "15.0"
assert len(mac["sha256"]) == 64 and mac["bytes"] > 0
linux = json.loads(pathlib.Path("$ROOT/pack/linux-x86_64/asset.json").read_text())
assert "minos" not in linux
print("ok   macos asset.json has minos 15.0 / linkage / format / executable")
PY

# --- expected-platform helpers ---
# shellcheck source=platforms.sh
source "$SCRIPT_DIR/platforms.sh"
assert_eq "$(expected_platforms_csv)" "linux-x86_64,macos-arm64" "expected platform list"
python3 - <<PY
import json, pathlib
partial = pathlib.Path("$ROOT/partial-manifest.json")
partial.write_text(json.dumps({
  "name": "tracemaker",
  "builtAt": "2026-10-09T22:00:00Z",
  "upstream": {"repository": "https://github.com/DingoOz/TraceMaker", "tag": "v0.9.0",
               "commit": "24c847772e57ea8888e2cfe4bbf1aa00666390a4", "license": "GPL-3.0-or-later",
               "sourceUrl": "https://example.test/src.tgz"},
  "assets": [{"platform": "linux-x86_64", "filename": "tracemaker-linux-x86_64.tar.gz",
              "url": "https://example.test/linux.tgz", "sha256": "a"*64, "bytes": 1, "format": "tar.gz",
              "executable": "tracemaker"}]
}) + "\n")
PY
assert_eq "$(missing_expected_platforms "$ROOT/partial-manifest.json")" "macos-arm64" "linux-only manifest is missing macos-arm64"
assert_eq "$(missing_expected_platforms "$ROOT/no-such-manifest.json")" "linux-x86_64 macos-arm64" "missing file → all platforms"

# --- publish: join platforms, --latest=false, complete a partial release ---
mkdir -p "$ROOT/ghbin" "$ROOT/ghstore"
cat > "$ROOT/ghbin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${GH_LOG:?}" "${GH_RELEASES:?}" "${GH_STORE:?}"
printf '%s\n' "$*" >> "$GH_LOG"
cmd="$1"
sub="$2"
shift 2
if [ "$cmd" = release ] && [ "$sub" = view ]; then
  tag="$1"
  if grep -qx "$tag" "$GH_RELEASES"; then
    exit 0
  fi
  exit 1
fi
if [ "$cmd" = release ] && [ "$sub" = create ]; then
  tag="$1"
  latest=true
  dest="$GH_STORE/$tag"
  mkdir -p "$dest"
  for arg in "$@"; do
    if [ "$arg" = "--latest=false" ]; then latest=false; fi
    if [ -f "$arg" ]; then cp "$arg" "$dest/$(basename "$arg")"; fi
  done
  echo "$tag latest=$latest" >> "${GH_LOG}.meta"
  echo "$tag" >> "$GH_RELEASES"
  exit 0
fi
if [ "$cmd" = release ] && [ "$sub" = upload ]; then
  tag="$1"
  dest="$GH_STORE/$tag"
  mkdir -p "$dest"
  echo "$tag upload" >> "${GH_LOG}.meta"
  for arg in "$@"; do
    if [ -f "$arg" ]; then cp "$arg" "$dest/$(basename "$arg")"; fi
  done
  exit 0
fi
if [ "$cmd" = release ] && [ "$sub" = download ]; then
  tag=""
  pattern=""
  dir="."
  while [ $# -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      --repo) shift 2 ;;
      *) if [ -z "$tag" ]; then tag="$1"; fi; shift ;;
    esac
  done
  src="$GH_STORE/$tag"
  mkdir -p "$dir"
  if [ -n "$pattern" ] && [ -f "$src/$pattern" ]; then
    cp "$src/$pattern" "$dir/"
    exit 0
  fi
  exit 1
fi
if [ "$cmd" = release ] && [ "$sub" = delete ]; then
  tag="$1"
  grep -vx "$tag" "$GH_RELEASES" > "${GH_RELEASES}.tmp" || true
  mv "${GH_RELEASES}.tmp" "$GH_RELEASES"
  rm -rf "$GH_STORE/$tag"
  exit 0
fi
echo "unexpected gh $*" >&2
exit 3
EOF
chmod +x "$ROOT/ghbin/gh"

export GH_TOKEN=fake
export GH_LOG="$ROOT/gh.log"
export GH_RELEASES="$ROOT/gh.releases"
export GH_STORE="$ROOT/ghstore"
: > "$GH_RELEASES"
: > "$GH_LOG"
PATH="$ROOT/ghbin:$PATH" bash "$SCRIPT_DIR/publish.sh" "$ROOT/pack"
assert_file "$ROOT/pack/manifest.json"
python3 - <<PY
import json, pathlib, sys
m = json.loads(pathlib.Path("$ROOT/pack/manifest.json").read_text())
plats = sorted(a["platform"] for a in m["assets"])
assert m["name"] == "tracemaker", m
assert m["upstream"]["commit"] == "24c847772e57ea8888e2cfe4bbf1aa00666390a4", m
assert plats == ["linux-x86_64", "macos-arm64"], plats
for a in m["assets"]:
    assert len(a["sha256"]) == 64 and a["bytes"] > 0
print("ok   manifest joins", plats, "commit", m["upstream"]["commit"])
PY
assert_contains "$ROOT/gh.log.meta" "tracemaker-v0.9.0-24c8477 latest=false"
assert_contains "$ROOT/gh.log.meta" "tracemaker-latest latest=false"

# second publish of a complete set uploads into the existing tag (force/rebuild) and does not
# recreate it with `release create` / --latest=true
: > "$GH_LOG"
: > "$ROOT/gh.log.meta"
PATH="$ROOT/ghbin:$PATH" bash "$SCRIPT_DIR/publish.sh" "$ROOT/pack" > "$ROOT/publish-complete.log"
assert_contains "$ROOT/publish-complete.log" "Completing existing"
if grep -q "release create tracemaker-v0.9.0-24c8477" "$GH_LOG"; then
  echo "FAIL recreated immutable tag instead of uploading"
  fail=1
else
  echo "ok   completed existing immutable tag via upload --clobber"
fi
assert_contains "$ROOT/gh.log.meta" "tracemaker-latest latest=false"

# partial release: only macos is new; linux is already published and must be merged
partial_pack="$ROOT/pack-macos-only"
mkdir -p "$partial_pack"
cp -a "$ROOT/pack/macos-arm64" "$partial_pack/"
rm -rf "$ROOT/pack"   # isolate
# Seed a linux-only immutable release (the state after run 37999311656).
linux_only="$ROOT/linux-only"
mkdir -p "$linux_only/linux-x86_64"
# Re-pack linux so we have a known archive + asset.json to seed the store.
bash "$SCRIPT_DIR/package.sh" "$fake_bin" linux-x86_64 "$linux_only/linux-x86_64" >/dev/null
: > "$GH_RELEASES"
: > "$GH_LOG"
: > "$ROOT/gh.log.meta"
rm -rf "$GH_STORE"
mkdir -p "$GH_STORE/tracemaker-v0.9.0-24c8477"
python3 - <<PY
import json, pathlib, shutil
src = pathlib.Path("$linux_only/linux-x86_64")
asset = json.loads((src / "asset.json").read_text())
store = pathlib.Path("$GH_STORE/tracemaker-v0.9.0-24c8477")
shutil.copy(src / asset["filename"], store / asset["filename"])
manifest = {
  "name": "tracemaker",
  "builtAt": "2026-10-09T21:00:00Z",
  "upstream": {
    "repository": "https://github.com/DingoOz/TraceMaker",
    "tag": "v0.9.0",
    "commit": "24c847772e57ea8888e2cfe4bbf1aa00666390a4",
    "license": "GPL-3.0-or-later",
    "sourceUrl": "https://github.com/DingoOz/TraceMaker/archive/24c847772e57ea8888e2cfe4bbf1aa00666390a4.tar.gz",
  },
  "assets": [asset],
}
(store / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("seeded linux-only release", asset["filename"], asset["sha256"][:12])
PY
echo "tracemaker-v0.9.0-24c8477" >> "$GH_RELEASES"
PATH="$ROOT/ghbin:$PATH" bash "$SCRIPT_DIR/publish.sh" "$partial_pack" > "$ROOT/publish-partial.log"
python3 - <<PY
import json, pathlib
m = json.loads(pathlib.Path("$partial_pack/manifest.json").read_text())
plats = sorted(a["platform"] for a in m["assets"])
assert plats == ["linux-x86_64", "macos-arm64"], plats
print("ok   partial publish merged", plats)
PY
assert_contains "$ROOT/publish-partial.log" "verified existing"
assert_contains "$ROOT/gh.log.meta" "tracemaker-v0.9.0-24c8477 upload"
assert_contains "$ROOT/gh.log.meta" "tracemaker-latest latest=false"
assert_eq "$(missing_expected_platforms "$partial_pack/manifest.json")" "" "merged manifest lists every expected platform"
TRACEMAKER_FORCE=1
if force_rebuild_requested; then
  echo "ok   TRACEMAKER_FORCE=1 is a rebuild"
else
  echo "FAIL TRACEMAKER_FORCE=1 not detected"
  fail=1
fi
unset TRACEMAKER_FORCE
if force_rebuild_requested; then
  echo "FAIL force defaulted on"
  fail=1
else
  echo "ok   force is off by default"
fi

# --- keep-going summary lists every FAILED target ---
cat > "$ROOT/ninja-fail.log" <<'EOF'
[12/80] Building CXX object src/drc/CMakeFiles/tm_drc.dir/engine.cpp.o
[13/80] Building CXX object src/drc/CMakeFiles/tm_drc.dir/rule_engine.cpp.o
FAILED: src/drc/CMakeFiles/tm_drc.dir/rule_engine.cpp.o
src/drc/rule_engine.cpp:154:23: error: no member named 'atof' in namespace 'std'; did you mean 'stof'?
[40/80] Building CXX object src/route/CMakeFiles/tm_route.dir/router.cpp.o
FAILED: src/route/CMakeFiles/tm_route.dir/router.cpp.o
src/route/router.cpp:3083:40: error: no member named 'atof' in namespace 'std'
ninja: build stopped: subcommand failed.
EOF
bash "$SCRIPT_DIR/summarize-build.sh" "$ROOT/ninja-fail.log" > "$ROOT/summary.out"
assert_contains "$ROOT/summary.out" "FAILED: src/drc/CMakeFiles/tm_drc.dir/rule_engine.cpp.o"
assert_contains "$ROOT/summary.out" "no member named 'atof'"
assert_contains "$ROOT/summary.out" "FAILED: src/route/CMakeFiles/tm_route.dir/router.cpp.o"
assert_contains "$ROOT/summary.out" "failed_targets=2"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "-include cstdlib"
assert_contains "$SCRIPT_DIR/build.sh" ".fabdesk-sqlite-inc"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "TM_ZSTD_LIBRARY"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "ZSTD_LIBRARY"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "zstd_DIR"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "macos_append_static_dep_cmake_args"
assert_contains "$SCRIPT_DIR/cmake/zstd-static/zstdConfig.cmake" "libzstd.a"
assert_contains "$SCRIPT_DIR/cmake/zstd-static/zstdConfig.cmake" "zstd::libzstd_shared"
assert_contains "$SCRIPT_DIR/cmake/macos-static-deps.cmake" "FATAL_ERROR"
assert_contains "$SCRIPT_DIR/build.sh" "summarize-build.sh"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "SQLite3_INCLUDE_DIR"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "SQLite3_LIBRARY"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "CMAKE_CXX_STANDARD_LIBRARIES"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "-nostdlib++"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "-Wl,-search_paths_first"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "-Wl,-force_load"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "lib/unwind"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "CMAKE_CXX_IMPLICIT_LINK_LIBRARIES"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "CMAKE_PROJECT_INCLUDE"
assert_contains "$SCRIPT_DIR/cmake/macos-static-deps.cmake" "zstd::libzstd_static"
assert_contains "$SCRIPT_DIR/verify-macos.sh" "/opt/homebrew"
assert_contains "$SCRIPT_DIR/verify-macos.sh" "/usr/lib/libsqlite3.dylib"

# ninja 1.12 FAILED: [code=1] + libc++ include-order hint (run 38005104781)
cat > "$ROOT/ninja-sqlite.log" <<'EOF'
[49/64] Building CXX object src/learn/CMakeFiles/tm_learn.dir/knowledge_base.cpp.o
FAILED: [code=1] src/learn/CMakeFiles/tm_learn.dir/knowledge_base.cpp.o
/opt/homebrew/opt/llvm/bin/clang++ -isystem /Applications/Xcode_16.4.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/include -nostdinc++ -isystem /opt/homebrew/opt/llvm/include/c++/v1 -c knowledge_base.cpp
In file included from <built-in>:1:
/opt/homebrew/opt/llvm/include/c++/v1/cstdlib:93:5: error: <cstdlib> tried including <stdlib.h> but didn't find libc++'s <stdlib.h> header.
[60/64] Building CXX object src/server/CMakeFiles/tm_server.dir/viewer_server.cpp.o
ninja: build stopped: cannot make progress due to previous errors.
EOF
bash "$SCRIPT_DIR/summarize-build.sh" "$ROOT/ninja-sqlite.log" > "$ROOT/summary-sqlite.out"
assert_contains "$ROOT/summary-sqlite.out" "FAILED: src/learn/CMakeFiles/tm_learn.dir/knowledge_base.cpp.o"
assert_contains "$ROOT/summary-sqlite.out" "tried including <stdlib.h>"
assert_contains "$ROOT/summary-sqlite.out" "last_progress:"
assert_contains "$ROOT/summary-sqlite.out" "failed_targets=1"
assert_contains "$ROOT/summary-sqlite.out" "isolated sqlite3.h"

# Successful ninja log with SDK warning text containing "error:" must stay quiet
# (run 38009143938 printed a FAILURE SUMMARY after [64/64] Linking).
cat > "$ROOT/ninja-ok.log" <<'EOF'
[64/64] Linking CXX executable src/app/tracemaker
ld: warning: ignoring duplicate libraries: 'src/core/libtm_core.a'
   36 |   kLSRequestAllInfo = (UInt32)0xFFFFFFFF /* resourceValuesForKeys:error: */
EOF
bash "$SCRIPT_DIR/summarize-build.sh" "$ROOT/ninja-ok.log" > "$ROOT/summary-ok.out"
if grep -q "FABDESK BUILD FAILURE SUMMARY" "$ROOT/summary-ok.out"; then
  echo "FAIL summary printed on a successful build"
  fail=1
else
  echo "ok   summarize is silent on a successful ninja log"
fi

# --- isolated sqlite3.h (no SDK usr/include) + refuse brew sqlite dylib ---
# shellcheck source=macos-llvm.sh
source "$SCRIPT_DIR/macos-llvm.sh"
sdk_inc="$ROOT/sdk/usr/include"
mkdir -p "$sdk_inc"
printf '%s\n' '/* fake sqlite3.h */' > "$sdk_inc/sqlite3.h"
printf '%s\n' '/* ext */' > "$sdk_inc/sqlite3ext.h"
mkdir -p "$ROOT/fakebin"
cat > "$ROOT/fakebin/xcrun" <<EOF
#!/bin/sh
if [ "\$1" = "--show-sdk-path" ]; then
  echo "$ROOT/sdk"
  exit 0
fi
exit 1
EOF
chmod +x "$ROOT/fakebin/xcrun"
PATH="$ROOT/fakebin:$PATH" TM_SQLITE_LIBRARY="$ROOT/libsqlite3-missing.dylib" \
  macos_isolate_sqlite "$ROOT/sqlite-inc-fail" >"$ROOT/sqlite-fail.out" 2>"$ROOT/sqlite-fail.err" && {
  echo "FAIL isolate accepted a missing SQLite library"
  fail=1
} || echo "ok   isolate rejects a missing SQLite library"
brew_dylib="$ROOT/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
mkdir -p "$(dirname "$brew_dylib")"
touch "$brew_dylib"
if PATH="$ROOT/fakebin:$PATH" TM_SQLITE_LIBRARY="$brew_dylib" \
  macos_isolate_sqlite "$ROOT/sqlite-inc-brew" >"$ROOT/sqlite-brew.out" 2>"$ROOT/sqlite-brew.err"; then
  echo "FAIL isolate accepted a Homebrew sqlite dylib"
  fail=1
else
  assert_contains "$ROOT/sqlite-brew.err" "refusing"
  echo "ok   isolate refuses Homebrew sqlite dylib"
fi
static_a="$ROOT/libsqlite3.a"
touch "$static_a"
PATH="$ROOT/fakebin:$PATH" TM_SQLITE_LIBRARY="$static_a" \
  macos_isolate_sqlite "$ROOT/sqlite-inc" >"$ROOT/sqlite-ok.out"
assert_file "$ROOT/sqlite-inc/sqlite3.h"
assert_file "$ROOT/sqlite-inc/sqlite3ext.h"
if [ -f "$ROOT/sqlite-inc/stdlib.h" ]; then
  echo "FAIL isolated sqlite dir contains stdlib.h"
  fail=1
else
  echo "ok   isolated sqlite dir has no C stdlib headers"
fi
assert_eq "$MACOS_SQLITE_INCLUDE_DIR" "$ROOT/sqlite-inc" "MACOS_SQLITE_INCLUDE_DIR is the isolated dir"
assert_eq "$MACOS_SQLITE_LIBRARY" "$static_a" "static libsqlite3.a is allowed"
assert_contains "$SCRIPT_DIR/macos-llvm.sh" "/usr/lib/libsqlite3.dylib"
fake_llvm="$ROOT/fake-llvm"
mkdir -p "$fake_llvm/lib/c++" "$fake_llvm/lib/unwind"
touch "$fake_llvm/lib/c++/libc++.a" "$fake_llvm/lib/c++/libc++abi.a" "$fake_llvm/lib/unwind/libunwind.a"
assert_eq "$(macos_find_llvm_archive "$fake_llvm" "libc++.a")" "$fake_llvm/lib/c++/libc++.a" "libc++.a from lib/c++"
assert_eq "$(macos_find_llvm_archive "$fake_llvm" "libunwind.a")" "$fake_llvm/lib/unwind/libunwind.a" "libunwind.a from lib/unwind"
zstd_a="$ROOT/zstd/lib/libzstd.a"
mkdir -p "$(dirname "$zstd_a")" "$ROOT/zstd/include"
touch "$zstd_a"
TM_ZSTD_LIBRARY="$zstd_a" TM_ZSTD_INCLUDE_DIR="$ROOT/zstd/include" macos_zstd_static >/dev/null
assert_eq "$MACOS_ZSTD_LIBRARY" "$zstd_a" "macos_zstd_static accepts libzstd.a"
zstd_dylib="$ROOT/opt/homebrew/opt/zstd/lib/libzstd.dylib"
mkdir -p "$(dirname "$zstd_dylib")"
touch "$zstd_dylib"
if TM_ZSTD_LIBRARY="$zstd_dylib" macos_zstd_static >"$ROOT/zstd-brew.out" 2>"$ROOT/zstd-brew.err"; then
  echo "FAIL macos_zstd_static accepted a zstd dylib"
  fail=1
else
  assert_contains "$ROOT/zstd-brew.err" "refusing"
  echo "ok   macos_zstd_static refuses a zstd dylib"
fi
if command -v cmake >/dev/null; then
  cmake_probe="$ROOT/cmake-zstd"
  mkdir -p "$cmake_probe"
  cat > "$cmake_probe/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.16)
project(zstdprobe NONE)
find_package(zstd CONFIG REQUIRED)
if(NOT TARGET zstd::libzstd_shared OR NOT TARGET zstd::libzstd_static)
  message(FATAL_ERROR "fabdesk zstd config must define both imported names")
endif()
get_target_property(_loc zstd::libzstd_shared IMPORTED_LOCATION)
if(NOT _loc MATCHES "\\.a$")
  message(FATAL_ERROR "zstd::libzstd_shared must resolve to libzstd.a, got ${_loc}")
endif()
EOF
  if cmake -S "$cmake_probe" -B "$cmake_probe/ok" \
    -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
    -DTM_ZSTD_LIBRARY="$zstd_a" \
    -DTM_ZSTD_INCLUDE_DIR="$ROOT/zstd/include" >"$ROOT/cmake-zstd-ok.out" 2>&1; then
    echo "ok   zstd CONFIG shim imports libzstd.a under shared+static names"
  else
    echo "FAIL cmake zstd CONFIG shim"
    cat "$ROOT/cmake-zstd-ok.out"
    fail=1
  fi
  if cmake -S "$cmake_probe" -B "$cmake_probe/bad" \
    -Dzstd_DIR="$SCRIPT_DIR/cmake/zstd-static" \
    -DTM_ZSTD_LIBRARY="$ROOT/missing-libzstd.a" >"$ROOT/cmake-zstd-bad.out" 2>&1; then
    echo "FAIL cmake zstd CONFIG accepted a missing archive"
    fail=1
  else
    assert_contains "$ROOT/cmake-zstd-bad.out" "TM_ZSTD_LIBRARY"
    echo "ok   zstd CONFIG fails loudly when libzstd.a is missing"
  fi
else
  echo "skip cmake zstd CONFIG probe (cmake not installed)"
fi

# zstd_DIR / TM_ZSTD_LIBRARY must be passed even when Homebrew LLVM is absent.
PATH="$ROOT/fakebin:$PATH" TM_SQLITE_LIBRARY="$static_a" \
  TM_ZSTD_LIBRARY="$zstd_a" TM_ZSTD_INCLUDE_DIR="$ROOT/zstd/include" \
  macos_llvm_prepare "$ROOT/sqlite-prep" >"$ROOT/prepare-no-llvm.out"
printf '%s\n' "${MACOS_LLVM_CMAKE_ARGS[@]}" > "$ROOT/prepare-args.txt"
assert_contains "$ROOT/prepare-args.txt" "zstd_DIR="
assert_contains "$ROOT/prepare-args.txt" "TM_ZSTD_LIBRARY="
assert_contains "$ROOT/prepare-args.txt" "ZSTD_LIBRARY="
assert_contains "$ROOT/prepare-no-llvm.out" "static zstd="

# strip then codesign last (install_name_tool, if used, is between them).
mkdir -p "$ROOT/mactools"
export MAC_TOOL_LOG="$ROOT/mac-tools.log"
: > "$MAC_TOOL_LOG"
for _tool in strip codesign install_name_tool; do
  cat > "$ROOT/mactools/$_tool" <<'EOF'
#!/bin/sh
printf '%s %s\n' "$(basename "$0")" "$*" >> "${MAC_TOOL_LOG:?}"
exit 0
EOF
  chmod +x "$ROOT/mactools/$_tool"
done
PATH="$ROOT/mactools:$PATH" bash "$SCRIPT_DIR/package.sh" "$fake_bin" macos-arm64 "$ROOT/pack/macos-order" >/dev/null
python3 - <<PY
from pathlib import Path
log = Path("$MAC_TOOL_LOG").read_text().splitlines()
names = [line.split()[0] for line in log if line.strip()]
if "strip" not in names or "codesign" not in names:
    raise SystemExit(f"FAIL expected strip+codesign in {names}")
if names.index("strip") > names.index("codesign"):
    raise SystemExit(f"FAIL codesign ran before strip: {names}")
print("ok   package.sh codesign runs after strip")
PY
if grep -E 'declare -A|mapfile|readarray|\$\{[A-Za-z_][A-Za-z0-9_]*,,\}' \
  "$SCRIPT_DIR/build.sh" "$SCRIPT_DIR/macos-llvm.sh" "$SCRIPT_DIR/verify-macos.sh" \
  "$SCRIPT_DIR/package.sh" "$SCRIPT_DIR/smoke.sh" "$SCRIPT_DIR/summarize-build.sh" \
  "$SCRIPT_DIR/bundle-libs.sh" "$SCRIPT_DIR/apply-macos-patch.sh"; then
  echo "FAIL macOS-path tracemaker scripts use bash 4+ features (/bin/bash is 3.2)"
  fail=1
else
  echo "ok   no bash 4+ features on the macOS script path (/bin/bash is 3.2)"
fi

# --- verify-macos.sh: allow system+sqlite+frameworks; reject brew / libc++ dylib ---
fake_macho="$ROOT/fake-tracemaker"
touch "$fake_macho"
mkdir -p "$ROOT/verifybin"
cat > "$ROOT/verifybin/file" <<'EOF'
#!/bin/sh
echo "Mach-O 64-bit executable arm64"
EOF
cat > "$ROOT/verifybin/otool" <<'EOF'
#!/bin/sh
case "$1" in
  -L)
    echo "$2:"
    echo "	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)"
    echo "	/usr/lib/libsqlite3.dylib (compatibility version 9.0.0, current version 3.43.2)"
    echo "	/usr/lib/libobjc.A.dylib (compatibility version 1.0.0, current version 228.0.0)"
    echo "	/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0, current version 367.8.0)"
    echo "	/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation (compatibility version 300.0.0, current version 4201.0.0)"
    if [ -n "${FAKE_OTOOL_EXTRA:-}" ]; then
      echo "	${FAKE_OTOOL_EXTRA} (compatibility version 1.0.0, current version 1.0.0)"
    fi
    exit 0
    ;;
  -l)
    echo "      cmd LC_BUILD_VERSION"
    echo "  minos 15.0"
    echo "    sdk 15.5"
    exit 0
    ;;
esac
echo "unexpected otool $*" >&2
exit 3
EOF
chmod +x "$ROOT/verifybin/file" "$ROOT/verifybin/otool"
if PATH="$ROOT/verifybin:$PATH" TM_MACOS_LIBCXX=llvm-static \
  bash "$SCRIPT_DIR/verify-macos.sh" "$fake_macho" >"$ROOT/verify-ok.out"; then
  assert_contains "$ROOT/verify-ok.out" "macos probe ok"
else
  echo "FAIL verify-macos rejected a clean system linkage"
  fail=1
fi
if PATH="$ROOT/verifybin:$PATH" TM_MACOS_LIBCXX=llvm-static FAKE_OTOOL_EXTRA=/opt/homebrew/opt/zstd/lib/libzstd.1.dylib \
  bash "$SCRIPT_DIR/verify-macos.sh" "$fake_macho" >"$ROOT/verify-brew.out" 2>"$ROOT/verify-brew.err"; then
  echo "FAIL verify-macos accepted a Homebrew zstd dylib"
  fail=1
else
  assert_contains "$ROOT/verify-brew.err" "/opt/homebrew"
  echo "ok   verify-macos rejects Homebrew zstd"
fi
if PATH="$ROOT/verifybin:$PATH" TM_MACOS_LIBCXX=llvm-static FAKE_OTOOL_EXTRA=/usr/lib/libc++.1.dylib \
  bash "$SCRIPT_DIR/verify-macos.sh" "$fake_macho" >"$ROOT/verify-libcxx.out" 2>"$ROOT/verify-libcxx.err"; then
  echo "FAIL verify-macos accepted system libc++ under llvm-static"
  fail=1
else
  assert_contains "$ROOT/verify-libcxx.err" "static LLVM libc++"
  echo "ok   verify-macos rejects /usr/lib/libc++.1.dylib when llvm-static"
fi
if PATH="$ROOT/verifybin:$PATH" TM_MACOS_LIBCXX=llvm-static FAKE_OTOOL_EXTRA=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib \
  bash "$SCRIPT_DIR/verify-macos.sh" "$fake_macho" >"$ROOT/verify-sqlbrew.out" 2>"$ROOT/verify-sqlbrew.err"; then
  echo "FAIL verify-macos accepted Homebrew sqlite dylib"
  fail=1
else
  assert_contains "$ROOT/verify-sqlbrew.err" "libsqlite3"
  echo "ok   verify-macos rejects Homebrew sqlite dylib"
fi

# --- apply-macos-patch is commit-pinned (wrong SHA is a no-op) ---
empty="$ROOT/empty-src"
mkdir -p "$empty/.git"
git -C "$empty" init -q
git -C "$empty" -c user.email=tracemaker-test@example.test -c user.name=test commit --allow-empty -m init -q
if bash "$SCRIPT_DIR/apply-macos-patch.sh" "$empty" > "$ROOT/patch-skip.log"; then
  assert_contains "$ROOT/patch-skip.log" "No commit-pinned macOS patch"
else
  echo "FAIL apply-macos-patch on unknown commit"
  fail=1
fi

# Real v0.9.0 tree when the caller cloned it (optional; skipped otherwise).
if [ -n "${TRACEMAKER_FIXTURE_SRC:-}" ]; then
  fixture="$(abs_existing_dir "$TRACEMAKER_FIXTURE_SRC")"
  pinned="$ROOT/tm-v090"
  cp -a "$fixture" "$pinned"
  bash "$SCRIPT_DIR/apply-macos-patch.sh" "$pinned" > "$ROOT/patch-apply.log"
  assert_contains "$ROOT/patch-apply.log" "Applying"
  assert_file "$pinned/.fabdesk-macos-patch"
  assert_file "$pinned/src/core/from_chars_double.hpp"
  assert_contains "$pinned/src/drc/rule_engine.cpp" "#include <cstdlib>"
  assert_contains "$pinned/src/route/router.cpp" "#include <cstdlib>"
  assert_contains "$pinned/src/io/kicad/board_reader.cpp" "#include <cstdlib>"
  assert_contains "$pinned/src/server/view_main.cpp" "#include <cstdlib>"
  if grep -R --include='*.cpp' 'std::from_chars(' "$pinned/src"; then
    echo "FAIL leftover std::from_chars( in patched cpp"
    fail=1
  else
    echo "ok   v0.9.0 patch removed every std::from_chars( in *.cpp"
  fi
  if grep -E 'strtod_l\(|newlocale\(|freelocale\(|<xlocale.h>' "$pinned/src/core/from_chars_double.hpp"; then
    echo "FAIL shim still uses locale C APIs that Homebrew LLVM does not declare"
    fail=1
  else
    echo "ok   shim has no strtod_l / newlocale"
  fi
  CXX=""
  if command -v g++ >/dev/null; then CXX=g++; elif command -v clang++ >/dev/null; then CXX=clang++; fi
  if [ -n "$CXX" ]; then
    cat > "$ROOT/shim_main.cpp" <<EOF
#include "$pinned/src/core/from_chars_double.hpp"
#include <cmath>
int main() {
  const char ok[] = "1.25";
  double v = 0;
  auto r = tmk::from_chars_double(ok, ok + 4, v);
  if (r.ec != std::errc{} || r.ptr != ok + 4 || std::fabs(v - 1.25) > 1e-9) return 1;
  const char bad[] = "1.25x";
  auto r2 = tmk::from_chars_double(bad, bad + 5, v);
  if (r2.ec == std::errc{}) return 2;
  const char expn[] = "1e3";
  auto r3 = tmk::from_chars_double(expn, expn + 3, v);
  if (r3.ec != std::errc{} || std::fabs(v - 1000) > 1e-9) return 3;
  return 0;
}
EOF
    if "$CXX" -std=c++20 -O0 -o "$ROOT/shim_main" "$ROOT/shim_main.cpp" && "$ROOT/shim_main"; then
      echo "ok   shim compiles and parses 1.25 / 1e3 with $CXX"
    else
      echo "FAIL shim compile or runtime check ($CXX)"
      fail=1
    fi
  fi
fi

# Packaged manifest must satisfy the TypeScript zod schema (same parser the app uses).
if command -v bun >/dev/null; then
  # JS, not a shell snippet — $MANIFEST is passed via the environment.
  # shellcheck disable=SC2016
  MANIFEST="$partial_pack/manifest.json" bun --cwd "$SCRIPT_DIR/../../packages/tools" -e '
    import { parseTraceMakerManifest } from "./src/routers/tracemaker-release";
    const raw = JSON.parse(await Bun.file(process.env.MANIFEST!).text());
    const m = parseTraceMakerManifest(raw);
    if (m.assets.length !== 2) throw new Error(`expected 2 assets, got ${m.assets.length}`);
    for (const a of m.assets) {
      if (a.linkage !== "system-libc-or-frameworks" && a.linkage !== "bundled-non-system-libs") {
        throw new Error(`unexpected linkage ${a.linkage}`);
      }
    }
    const mac = m.assets.find((a) => a.platform === "macos-arm64");
    if (!mac || mac.minos !== "15.0" || mac.format !== "tar.gz" || mac.executable !== "tracemaker") {
      throw new Error(`macos-arm64 asset fields: ${JSON.stringify(mac)}`);
    }
    console.log("ok   parseTraceMakerManifest accepts packaged manifest");
  '
fi

if [ "$fail" -ne 0 ]; then
  echo "script tests failed"
  exit 1
fi
echo "all script tests passed"
