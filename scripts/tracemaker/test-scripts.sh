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

# Windows configure uses cmake -S/-B, not --preset (upstream PATH is Unix-only).
cat > "$ws/fakebin/cmake" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --build "* ]]; then
  mkdir -p build/windows-x86_64/src/app
  printf 'MZ\n' > build/windows-x86_64/src/app/tracemaker.exe
  echo "[63/63] Linking CXX executable src/app/tracemaker.exe"
  exit 0
fi
if [[ " $* " == *" -S "* ]] || [[ " $* " == *"-S "* ]]; then
  mkdir -p build/windows-x86_64
  echo "-- configured windows-x86_64 in $PWD"
  exit 0
fi
mkdir -p build/cpu-only
echo "-- configured cpu-only in $PWD"
EOF
chmod +x "$ws/fakebin/cmake"
(
  cd "$ws"
  TM_WINDOWS_SKIP_DEPS=1 \
  PATH="$ws/fakebin:$PATH" bash "$SCRIPT_DIR/build.sh" TraceMaker windows-x86_64 > "$ROOT/build-win.out"
)
win_binary="$(awk -F= '/^binary=/{print $2}' "$ROOT/build-win.out")"
assert_eq "$win_binary" "$ws/TraceMaker/build/windows-x86_64/src/app/tracemaker.exe" "build.sh windows emits tracemaker.exe"
assert_file "$win_binary"

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
printf '%s\n' llvm-static > "$src_tree/.fabdesk-macos-libcxx"

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
  bash "$SCRIPT_DIR/package.sh" "$fake_bin" windows-x86_64 pack/windows-x86_64
)
assert_file "$ROOT/pack/linux-x86_64/asset.json"
assert_file "$ROOT/pack/macos-arm64/asset.json"
assert_file "$ROOT/pack/windows-x86_64/asset.json"
assert_file "$ROOT/pack/linux-x86_64/tracemaker-linux-x86_64.tar.gz"
assert_file "$ROOT/pack/macos-arm64/tracemaker-macos-arm64.tar.gz"
assert_file "$ROOT/pack/windows-x86_64/tracemaker-windows-x86_64.zip"
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
assert mac["cxxRuntime"] == "llvm-static"
assert mac["macosVariant"] == "llvm-static"
assert len(mac["sha256"]) == 64 and mac["bytes"] > 0
linux = json.loads(pathlib.Path("$ROOT/pack/linux-x86_64/asset.json").read_text())
assert "minos" not in linux
assert "cxxRuntime" not in linux
print("ok   macos asset.json has minos 15.0 / linkage / cxxRuntime / format / executable")
win = json.loads(pathlib.Path("$ROOT/pack/windows-x86_64/asset.json").read_text())
assert win["platform"] == "windows-x86_64"
assert win["format"] == "zip"
assert win["executable"] == "tracemaker.exe"
assert "minos" not in win
print("ok   windows asset.json has format zip / executable tracemaker.exe")
PY
if command -v unzip >/dev/null; then
  unzip -l "$ROOT/pack/windows-x86_64/tracemaker-windows-x86_64.zip" > "$ROOT/windows-zip.list"
  for _need in tracemaker.exe LICENSE NOTICE SOURCE.txt DEPENDENCIES.txt; do
    if grep -q "${_need}" "$ROOT/windows-zip.list"; then
      echo "ok   windows archive contains $_need"
    else
      echo "FAIL windows archive missing $_need"
      cat "$ROOT/windows-zip.list"
      fail=1
    fi
  done
fi
assert_contains "$ROOT/pack/windows-x86_64/DEPENDENCIES.txt" "Windows best-effort"
assert_contains "$ROOT/pack/windows-x86_64/SOURCE.txt" "GPL-3.0"

# zip present → Info-ZIP. Missing zip (self-hosted verify) → python3 -m zipfile.
if command -v zip >/dev/null 2>&1; then
  bash "$SCRIPT_DIR/package.sh" "$fake_bin" windows-x86_64 "$ROOT/pack/windows-zipbin" \
    >"$ROOT/windows-zipbin.log"
  assert_contains "$ROOT/windows-zipbin.log" "with zip"
  if grep -q "zipfile" "$ROOT/windows-zipbin.log"; then
    echo "FAIL zip was on PATH but python zipfile ran"
    fail=1
  else
    echo "ok   package.sh uses zip when it is on PATH"
  fi
else
  echo "ok   this machine has no zip; the fallback test below is the zip path"
fi

# Simulate a runner whose PATH has no zip binary (do not shadow it with a function;
# `command -v zip` would still see a function).
nozip_root="$ROOT/nozip-path"
mkdir -p "$nozip_root"
nozip_path=""
nozip_i=0
nozip_ifs="$IFS"
IFS=':'
for nozip_p in $PATH; do
  nozip_i=$((nozip_i + 1))
  if [ -z "$nozip_p" ]; then
    continue
  fi
  if [ -e "$nozip_p/zip" ]; then
    nozip_s="$nozip_root/$nozip_i"
    mkdir -p "$nozip_s"
    for nozip_f in "$nozip_p"/*; do
      if [ ! -e "$nozip_f" ]; then
        continue
      fi
      nozip_base="${nozip_f##*/}"
      if [ "$nozip_base" = "zip" ]; then
        continue
      fi
      ln -s "$nozip_f" "$nozip_s/$nozip_base"
    done
    nozip_path="${nozip_path:+$nozip_path:}$nozip_s"
  else
    nozip_path="${nozip_path:+$nozip_path:}$nozip_p"
  fi
done
IFS="$nozip_ifs"
if PATH="$nozip_path" command -v zip >/dev/null 2>&1; then
  echo "FAIL filtered PATH still contains zip"
  fail=1
else
  echo "ok   filtered PATH has no zip"
fi
if ! PATH="$nozip_path" command -v python3 >/dev/null 2>&1 && ! PATH="$nozip_path" command -v python >/dev/null 2>&1; then
  echo "FAIL filtered PATH lost python"
  fail=1
fi
PATH="$nozip_path" bash "$SCRIPT_DIR/package.sh" "$fake_bin" windows-x86_64 "$ROOT/pack/windows-nozip" \
  >"$ROOT/windows-nozip.log"
assert_contains "$ROOT/windows-nozip.log" "-m zipfile"
assert_contains "$ROOT/windows-nozip.log" "zip not on PATH"
assert_file "$ROOT/pack/windows-nozip/tracemaker-windows-x86_64.zip"
python3 - <<PY
import zipfile
z = zipfile.ZipFile("$ROOT/pack/windows-nozip/tracemaker-windows-x86_64.zip")
names = set(z.namelist())
missing = [n for n in ("tracemaker.exe", "LICENSE", "NOTICE", "SOURCE.txt", "DEPENDENCIES.txt") if n not in names]
if missing:
    raise SystemExit(f"FAIL python zipfile layout missing {missing}; have {sorted(names)}")
print("ok   python zipfile fallback layout", sorted(n for n in names if "/" not in n.rstrip("/")))
PY
printf '%s\n' system > "$src_tree/.fabdesk-macos-libcxx"
{
  echo "macOS variant A (preferred): Apple clang + system /usr/lib/libc++.1.dylib."
} > "$src_tree/.fabdesk-macos-link"
bash "$SCRIPT_DIR/package.sh" "$fake_bin" macos-arm64 "$ROOT/pack/macos-system" >/dev/null
assert_contains "$ROOT/pack/macos-system/DEPENDENCIES.txt" "variant A"
assert_contains "$ROOT/pack/macos-system/SOURCE.txt" "system /usr/lib/libc++.1.dylib"
python3 - <<PY
import json, pathlib
mac = json.loads(pathlib.Path("$ROOT/pack/macos-system/asset.json").read_text())
assert mac["cxxRuntime"] == "system"
assert mac["macosVariant"] == "system"
print("ok   system-libcxx package records cxxRuntime=system")
PY

# --- expected-platform helpers ---
# shellcheck source=platforms.sh
source "$SCRIPT_DIR/platforms.sh"
assert_eq "$(expected_platforms_csv)" "linux-x86_64,macos-arm64,windows-x86_64" "expected platform list"
assert_eq "$(required_platforms_csv)" "linux-x86_64,macos-arm64" "required platform list"
assert_eq "$(optional_platforms_csv)" "windows-x86_64" "optional platform list"
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
assert_eq "$(missing_expected_platforms "$ROOT/partial-manifest.json")" "macos-arm64 windows-x86_64" "linux-only manifest is missing macos + windows"
assert_eq "$(missing_expected_platforms "$ROOT/no-such-manifest.json")" "linux-x86_64 macos-arm64 windows-x86_64" "missing file → all platforms"
printf '%s\n' '{"platforms":{"windows-x86_64":{"status":"failed","attempts":3}}}' > "$ROOT/waived-status.json"
assert_eq "$(missing_build_platforms "$ROOT/partial-manifest.json" "$ROOT/waived-status.json")" "macos-arm64" "waived windows is omitted from the next build list"
assert_eq "$(waived_optional_platforms "$ROOT/waived-status.json")" "windows-x86_64" "three failures waive windows"
printf '%s\n' '{"platforms":{"windows-x86_64":{"status":"failed","attempts":1}}}' > "$ROOT/retry-status.json"
assert_eq "$(missing_build_platforms "$ROOT/partial-manifest.json" "$ROOT/retry-status.json")" "macos-arm64 windows-x86_64" "one Windows failure still rebuilds windows"

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
assert plats == ["linux-x86_64", "macos-arm64", "windows-x86_64"], plats
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

# GNU cp (ubuntu-latest) errors when src and dest are the same file. After the
# first publish, find $artifacts_dir -name LICENSE can return the root copy
# (CI run 38015352358). publish.sh must not cp that onto itself.
same_dir="$ROOT/same-file"
mkdir -p "$same_dir"
printf 'x\n' > "$same_dir/LICENSE"
if cp "$same_dir/LICENSE" "$same_dir/LICENSE" 2>"$ROOT/same-file.err"; then
  echo "ok   this cp allows same-file (not GNU); publish.sh still skips via -ef"
else
  assert_contains "$ROOT/same-file.err" "same file"
  echo "ok   GNU cp rejects same-file (the publish.sh second-run bug)"
fi

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
assert_eq "$(missing_expected_platforms "$partial_pack/manifest.json")" "windows-x86_64" "linux+macos merge is still missing windows"
assert_eq "$(missing_build_platforms "$partial_pack/manifest.json" "$ROOT/waived-status.json")" "" "waived windows lets the weekly run skip"
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
cat > "$ROOT/fakebin/brew" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$ROOT/fakebin/xcrun" "$ROOT/fakebin/brew"
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
assert_contains "$ROOT/prepare-args.txt" "Werror=unguarded-availability-new"
if grep -q 'CMAKE_CXX_COMPILER=.*/llvm/' "$ROOT/prepare-args.txt"; then
  echo "FAIL auto-without-llvm still pointed CMAKE_CXX_COMPILER at Homebrew LLVM"
  fail=1
else
  echo "ok   auto-without-llvm uses Apple clang (no Homebrew CMAKE_CXX_COMPILER)"
fi

PATH="$ROOT/fakebin:$PATH" TM_SQLITE_LIBRARY="$static_a" \
  TM_ZSTD_LIBRARY="$zstd_a" TM_ZSTD_INCLUDE_DIR="$ROOT/zstd/include" \
  TM_MACOS_LIBCXX=system macos_llvm_prepare "$ROOT/sqlite-prep-system" >"$ROOT/prepare-system.out"
printf '%s\n' "${MACOS_LLVM_CMAKE_ARGS[@]}" > "$ROOT/prepare-system-args.txt"
assert_contains "$ROOT/prepare-system-args.txt" "Werror=unguarded-availability-new"
assert_eq "$MACOS_LIBCXX" "system" "TM_MACOS_LIBCXX=system forces MACOS_LIBCXX=system"
if grep -q 'CMAKE_CXX_COMPILER=' "$ROOT/prepare-system-args.txt"; then
  echo "FAIL system variant set CMAKE_CXX_COMPILER (preset must keep /usr/bin/clang++)"
  fail=1
else
  echo "ok   system variant leaves CMAKE_CXX_COMPILER to the macos-metal preset"
fi
if PATH="$ROOT/fakebin:$PATH" TM_SQLITE_LIBRARY="$static_a" \
  TM_ZSTD_LIBRARY="$zstd_a" TM_ZSTD_INCLUDE_DIR="$ROOT/zstd/include" \
  TM_MACOS_LIBCXX=llvm-static macos_llvm_prepare "$ROOT/sqlite-prep-llvm" \
  >"$ROOT/prepare-llvm-missing.out" 2>"$ROOT/prepare-llvm-missing.err"; then
  echo "FAIL TM_MACOS_LIBCXX=llvm-static succeeded without Homebrew LLVM"
  fail=1
else
  assert_contains "$ROOT/prepare-llvm-missing.err" "llvm-static"
  echo "ok   TM_MACOS_LIBCXX=llvm-static fails when Homebrew LLVM is absent"
fi

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
  "$SCRIPT_DIR/bundle-libs.sh" "$SCRIPT_DIR/apply-macos-patch.sh" \
  "$SCRIPT_DIR/diagnose-macos.sh" "$SCRIPT_DIR/macos-variants.sh"; then
  echo "FAIL macOS-path tracemaker scripts use bash 4+ features (/bin/bash is 3.2)"
  fail=1
else
  echo "ok   no bash 4+ features on the macOS script path (/bin/bash is 3.2)"
fi

if bash "$SCRIPT_DIR/diagnose-macos.sh" "$fake_bin" "$ROOT/diag-linux" >"$ROOT/diag-linux.out"; then
  assert_contains "$ROOT/diag-linux.out" "skip macos abort diagnostics"
  echo "ok   diagnose-macos.sh skips on non-Darwin"
else
  echo "FAIL diagnose-macos.sh exited non-zero on Linux"
  fail=1
fi
assert_contains "$SCRIPT_DIR/macos-variants.sh" "for variant in system llvm-static"
assert_contains "$SCRIPT_DIR/macos-variants.sh" "diagnose-macos.sh"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "tracemaker-macos-arm64-debug"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "tracemaker-windows-x86_64-debug"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "continue-on-error: true"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "windows-x86_64"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "mirror-public.sh"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "github.event_name == 'workflow_dispatch' && (inputs.force == true || inputs.force == 'true')"
assert_contains "$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml" "release_exists"
assert_contains "$SCRIPT_DIR/package.sh" "python3 -m zipfile"
python3 - <<PY
from pathlib import Path
text = Path("$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml").read_text()
needle = 'bash "\${GITHUB_WORKSPACE}/scripts/tracemaker/mirror-public.sh"'
idx = text.find(needle)
if idx < 0:
    raise SystemExit("FAIL workflow does not run mirror-public.sh")
window = text[max(0, idx - 1200):idx]
if "continue-on-error" in window:
    raise SystemExit("FAIL mirror-public.sh step is continue-on-error")
if "needs.resolve.outputs.release_exists == 'true'" not in text:
    raise SystemExit("FAIL mirror job does not run when the release already exists")
print("ok   mirror job fails loudly and still runs when the release exists")
PY

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
if PATH="$ROOT/verifybin:$PATH" TM_MACOS_LIBCXX=system FAKE_OTOOL_EXTRA=/usr/lib/libc++.1.dylib \
  bash "$SCRIPT_DIR/verify-macos.sh" "$fake_macho" >"$ROOT/verify-system.out" 2>"$ROOT/verify-system.err"; then
  assert_contains "$ROOT/verify-system.out" "macos probe ok"
  echo "ok   verify-macos allows /usr/lib/libc++.1.dylib for variant A (system)"
else
  echo "FAIL verify-macos rejected system libc++ under TM_MACOS_LIBCXX=system"
  cat "$ROOT/verify-system.err"
  fail=1
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

# Real v0.9.0 tree when the caller cloned it. CI does not set this and must
# not clone or hit the network.
if [ -z "${TRACEMAKER_FIXTURE_SRC:-}" ]; then
  echo "skip v0.9.0 tree tests (TRACEMAKER_FIXTURE_SRC unset; no network)"
fi
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
  if grep -R --include='*.cpp' --include='*.hpp' --include='*.mm' \
    -e 'std::format' -e 'std::print(' -e 'std::println' -e 'std::chrono::tzdb' \
    -e 'std::chrono::current_zone' "$pinned/src"; then
    echo "FAIL patched tree still references macOS-15-unavailable libc++ APIs"
    fail=1
  else
    echo "ok   patched tree has no std::format / tzdb / current_zone"
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

# bash -n + CMake shim configure (run 38013328567: missing `()` only showed up on macos-15).
for _sh in "$SCRIPT_DIR"/*.sh; do
  if bash -n "$_sh"; then
    echo "ok   bash -n $(basename "$_sh")"
  else
    echo "FAIL bash -n $_sh"
    fail=1
  fi
done
# Inherit TM_REQUIRE_CMAKE from the caller. The hosted ubuntu-latest job
# sets it to 1 so missing cmake/cc/ar fail CI. verify is self-hosted and
# cannot sudo-install cmake; forcing 1 here made that job fail even though
# check-cmake.sh would have skipped with a notice (run 38015800636).
if bash "$SCRIPT_DIR/check-cmake.sh" "$ROOT/cmake-check" >"$ROOT/cmake-check.out" 2>&1; then
  cat "$ROOT/cmake-check.out"
  if grep -q "cmake shim checks passed" "$ROOT/cmake-check.out"; then
    echo "ok   check-cmake.sh (parse + harness + fatal dylib/missing)"
  elif grep -q "skip cmake harness" "$ROOT/cmake-check.out"; then
    if [ "${TM_REQUIRE_CMAKE:-}" = 1 ]; then
      echo "FAIL check-cmake.sh skipped while TM_REQUIRE_CMAKE=1"
      fail=1
    else
      echo "ok   check-cmake.sh skipped (tools missing; hosted job is the gate)"
    fi
  else
    echo "FAIL check-cmake.sh exited 0 without a pass or skip marker"
    fail=1
  fi
else
  cat "$ROOT/cmake-check.out"
  echo "FAIL check-cmake.sh"
  fail=1
fi
mkdir -p "$ROOT/emptybin"
# Coreutils only — no cmake/cc/ar — so we can test skip vs TM_REQUIRE_CMAKE=1.
for _t in dirname mkdir pwd; do
  _src="$(command -v "$_t" || true)"
  if [ -n "$_src" ]; then
    ln -s "$_src" "$ROOT/emptybin/$_t"
  fi
done
# Invoke with /bin/bash so PATH can omit cmake without hiding the shell.
if PATH="$ROOT/emptybin" TM_REQUIRE_CMAKE=1 /bin/bash "$SCRIPT_DIR/check-cmake.sh" "$ROOT/cmake-missing" \
  >"$ROOT/cmake-req.out" 2>"$ROOT/cmake-req.err"; then
  echo "FAIL TM_REQUIRE_CMAKE=1 succeeded without cmake"
  fail=1
else
  assert_contains "$ROOT/cmake-req.err" "required"
  echo "ok   TM_REQUIRE_CMAKE=1 fails when cmake/cc/ar are missing"
fi
if PATH="$ROOT/emptybin" /usr/bin/env -u TM_REQUIRE_CMAKE /bin/bash "$SCRIPT_DIR/check-cmake.sh" "$ROOT/cmake-skip" \
  >"$ROOT/cmake-skip.out" 2>"$ROOT/cmake-skip.err"; then
  assert_contains "$ROOT/cmake-skip.out" "skip cmake harness"
  echo "ok   check-cmake.sh skips with notice when tools are missing"
else
  echo "FAIL optional cmake harness failed instead of skipping"
  cat "$ROOT/cmake-skip.out" "$ROOT/cmake-skip.err"
  fail=1
fi

# --- public manifest rewrite + skip when credentials are unset ---
python3 "$SCRIPT_DIR/rewrite-public-manifest.py" "$partial_pack/manifest.json" \
  --base-url "https://downloads.fabplane.com/tracemaker" \
  --tag "tracemaker-v0.9.0-24c8477" \
  --out "$ROOT/public-manifest.json"
python3 - <<PY
import json, pathlib
priv = json.loads(pathlib.Path("$partial_pack/manifest.json").read_text())
pub = json.loads(pathlib.Path("$ROOT/public-manifest.json").read_text())
assert len(priv["assets"]) == len(pub["assets"])
for a, b in zip(priv["assets"], pub["assets"]):
    assert a["sha256"] == b["sha256"], (a, b)
    assert a["bytes"] == b["bytes"]
    assert b["url"].startswith("https://downloads.fabplane.com/tracemaker/tracemaker-v0.9.0-24c8477/")
    assert not b["url"].startswith("https://github.com/")
print("ok   rewritten public manifest keeps sha256 and retargets URLs")
PY
env -u TRACEMAKER_S3_ACCESS_KEY_ID -u TRACEMAKER_S3_SECRET_ACCESS_KEY \
  -u TRACEMAKER_S3_BUCKET -u TRACEMAKER_S3_ENDPOINT \
  -u TRACEMAKER_PUBLIC_BASE_URL -u TRACEMAKER_PUBLIC_RELEASE_REPO \
  -u TRACEMAKER_PUBLIC_RELEASE_TOKEN \
  -u DESKTOP_R2_ACCESS_KEY_ID -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN \
  TRACEMAKER_RELEASE_TAG=tracemaker-v0.9.0-24c8477 \
  bash "$SCRIPT_DIR/mirror-public.sh" "$partial_pack" > "$ROOT/mirror-skip.out"
assert_contains "$ROOT/mirror-skip.out" "Public TraceMaker mirror skipped"

# Credentials configured, but the merged manifest names an archive that is not
# on disk (linux was kept on the private release, not copied into this folder).
set +e
env -u TRACEMAKER_PUBLIC_RELEASE_REPO -u TRACEMAKER_PUBLIC_RELEASE_TOKEN \
  -u DESKTOP_R2_ACCESS_KEY_ID -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN \
  TRACEMAKER_S3_ACCESS_KEY_ID=dummy-access \
  TRACEMAKER_S3_SECRET_ACCESS_KEY=dummy-secret \
  TRACEMAKER_S3_BUCKET=fabplane-downloads \
  TRACEMAKER_S3_ENDPOINT=http://127.0.0.1:9 \
  TRACEMAKER_PUBLIC_BASE_URL=http://127.0.0.1:9 \
  TRACEMAKER_S3_PREFIX=tracemaker \
  TRACEMAKER_RELEASE_TAG=tracemaker-v0.9.0-24c8477 \
  bash "$SCRIPT_DIR/mirror-public.sh" "$partial_pack" >"$ROOT/mirror-missing.out" 2>&1
mirror_missing_rc=$?
set -e
if [ "$mirror_missing_rc" -eq 0 ]; then
  echo "FAIL mirror exited 0 with a manifest archive missing on disk"
  fail=1
else
  echo "ok   mirror exits non-zero when a manifest archive is missing"
fi
assert_contains "$ROOT/mirror-missing.out" "missing archives"
if grep -q "dummy-secret" "$ROOT/mirror-missing.out"; then
  echo "FAIL mirror log printed the dummy secret"
  fail=1
fi

# Flat release download (gh release download) plus a local stand-in for R2.
mirror_flat="$ROOT/mirror-flat"
mkdir -p "$mirror_flat"
cp "$partial_pack/manifest.json" "$mirror_flat/manifest.json"
python3 - <<PY
import json, pathlib, shutil
manifest = json.loads(pathlib.Path("$partial_pack/manifest.json").read_text())
dest = pathlib.Path("$mirror_flat")
roots = [pathlib.Path("$partial_pack"), pathlib.Path("$linux_only"), pathlib.Path("$ROOT/pack")]
for asset in manifest["assets"]:
    name = asset["filename"]
    found = None
    for root in roots:
        hits = [p for p in root.rglob(name) if p.is_file() and p.name == name]
        if hits:
            found = hits[0]
            break
    if found is None:
        raise SystemExit(f"FAIL could not stage {name} for mirror test")
    shutil.copy(found, dest / name)
print("ok   staged flat mirror dir", sorted(p.name for p in dest.iterdir()))
PY

cat > "$ROOT/mirror-http.py" <<'PY'
#!/usr/bin/env python3
"""PUT stores the body; GET serves it by path suffix. Optional corrupt GETs."""
from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

store: dict[str, bytes] = {}
corrupt = "--corrupt" in sys.argv


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        store[self.path.split("?", 1)[0]] = self.rfile.read(length)
        self._send(200, b"")

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if corrupt:
            self._send(200, b"corrupt")
            return
        if path in store:
            self._send(200, store[path])
            return
        matches = [(len(key), body) for key, body in store.items() if key.endswith(path)]
        if not matches:
            self._send(404, b"missing")
            return
        matches.sort()
        self._send(200, matches[-1][1])

    def log_message(self, fmt: str, *args: object) -> None:
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY

http_pid=""
trap 'if [ -n "${http_pid:-}" ]; then kill "$http_pid" 2>/dev/null || true; wait "$http_pid" 2>/dev/null || true; fi; rm -rf "$ROOT"' EXIT

start_mirror_http() {
  http_pid=""
  : > "$ROOT/mirror-http.port"
  python3 "$ROOT/mirror-http.py" "$@" >"$ROOT/mirror-http.port" &
  http_pid=$!
  mirror_port=""
  _i=0
  while [ "$_i" -lt 50 ]; do
    mirror_port="$(tr -d '[:space:]' < "$ROOT/mirror-http.port" || true)"
    if [ -n "$mirror_port" ]; then
      break
    fi
    _i=$((_i + 1))
    sleep 0.05
  done
  if [ -z "$mirror_port" ]; then
    echo "FAIL mirror http stub did not bind"
    fail=1
    return 1
  fi
}

stop_mirror_http() {
  if [ -n "${http_pid:-}" ]; then
    kill "$http_pid" 2>/dev/null || true
    wait "$http_pid" 2>/dev/null || true
    http_pid=""
  fi
}

start_mirror_http
set +e
env -u TRACEMAKER_PUBLIC_RELEASE_REPO -u TRACEMAKER_PUBLIC_RELEASE_TOKEN \
  -u DESKTOP_R2_ACCESS_KEY_ID -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN \
  TRACEMAKER_S3_ACCESS_KEY_ID=dummy-access \
  TRACEMAKER_S3_SECRET_ACCESS_KEY=dummy-secret \
  TRACEMAKER_S3_BUCKET=fabplane-downloads \
  TRACEMAKER_S3_ENDPOINT="http://127.0.0.1:${mirror_port}" \
  TRACEMAKER_PUBLIC_BASE_URL="http://127.0.0.1:${mirror_port}" \
  TRACEMAKER_S3_PREFIX=tracemaker \
  TRACEMAKER_RELEASE_TAG=tracemaker-v0.9.0-24c8477 \
  bash "$SCRIPT_DIR/mirror-public.sh" "$mirror_flat" >"$ROOT/mirror-ok.out" 2>&1
mirror_ok_rc=$?
set -e
if [ "$mirror_ok_rc" -ne 0 ]; then
  echo "FAIL configured mirror did not succeed against the local stub"
  cat "$ROOT/mirror-ok.out"
  fail=1
else
  echo "ok   configured mirror uploads and re-checks sha256"
fi
assert_contains "$ROOT/mirror-ok.out" "tracemaker-latest/manifest.json"
assert_contains "$ROOT/mirror-ok.out" "verified public"
if grep -q "using desktop R2 credentials" "$ROOT/mirror-ok.out"; then
  echo "FAIL TRACEMAKER_S3_* path claimed desktop credentials"
  fail=1
else
  echo "ok   TRACEMAKER_S3_* mirror does not claim desktop credentials"
fi
if grep -q "dummy-secret" "$ROOT/mirror-ok.out"; then
  echo "FAIL mirror success log printed the dummy secret"
  fail=1
fi
stop_mirror_http

start_mirror_http --corrupt
set +e
env -u TRACEMAKER_PUBLIC_RELEASE_REPO -u TRACEMAKER_PUBLIC_RELEASE_TOKEN \
  -u DESKTOP_R2_ACCESS_KEY_ID -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN \
  TRACEMAKER_S3_ACCESS_KEY_ID=dummy-access \
  TRACEMAKER_S3_SECRET_ACCESS_KEY=dummy-secret \
  TRACEMAKER_S3_BUCKET=fabplane-downloads \
  TRACEMAKER_S3_ENDPOINT="http://127.0.0.1:${mirror_port}" \
  TRACEMAKER_PUBLIC_BASE_URL="http://127.0.0.1:${mirror_port}" \
  TRACEMAKER_S3_PREFIX=tracemaker \
  TRACEMAKER_RELEASE_TAG=tracemaker-v0.9.0-24c8477 \
  bash "$SCRIPT_DIR/mirror-public.sh" "$mirror_flat" >"$ROOT/mirror-badsha.out" 2>&1
mirror_bad_rc=$?
set -e
if [ "$mirror_bad_rc" -eq 0 ]; then
  echo "FAIL mirror exited 0 after a sha256 mismatch"
  fail=1
else
  echo "ok   mirror exits non-zero when the sha256 re-check fails"
fi
assert_contains "$ROOT/mirror-badsha.out" "checksum mismatch"
if grep -q "Public TraceMaker mirror is live" "$ROOT/mirror-badsha.out"; then
  echo "FAIL checksum failure still reported the mirror live"
  fail=1
fi
stop_mirror_http

# Upload itself fails (connection refused) when every archive is present.
set +e
env -u TRACEMAKER_PUBLIC_RELEASE_REPO -u TRACEMAKER_PUBLIC_RELEASE_TOKEN \
  -u DESKTOP_R2_ACCESS_KEY_ID -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN \
  TRACEMAKER_S3_ACCESS_KEY_ID=dummy-access \
  TRACEMAKER_S3_SECRET_ACCESS_KEY=dummy-secret \
  TRACEMAKER_S3_BUCKET=fabplane-downloads \
  TRACEMAKER_S3_ENDPOINT=http://127.0.0.1:9 \
  TRACEMAKER_PUBLIC_BASE_URL=http://127.0.0.1:9 \
  TRACEMAKER_S3_PREFIX=tracemaker \
  TRACEMAKER_RELEASE_TAG=tracemaker-v0.9.0-24c8477 \
  bash "$SCRIPT_DIR/mirror-public.sh" "$mirror_flat" >"$ROOT/mirror-upload-fail.out" 2>&1
mirror_upload_rc=$?
set -e
if [ "$mirror_upload_rc" -eq 0 ]; then
  echo "FAIL mirror exited 0 when S3 upload failed"
  fail=1
else
  echo "ok   mirror exits non-zero when the upload fails"
fi
assert_contains "$ROOT/mirror-upload-fail.out" "S3 upload failed"
if grep -q "Public TraceMaker mirror skipped" "$ROOT/mirror-upload-fail.out"; then
  echo "FAIL upload failure was reported as a credential skip"
  fail=1
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
    if (!mac || mac.minos !== "15.0" || mac.format !== "tar.gz" || mac.executable !== "tracemaker"
        || (mac.cxxRuntime !== "llvm-static" && mac.cxxRuntime !== "system")) {
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
