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

# --- package both platforms (relative dest + TRACEMAKER_SRC) ---
src_tree="$ROOT/tm-src"
mkdir -p "$src_tree"
printf 'GPL-3.0-or-later\n' > "$src_tree/LICENSE"
printf 'NOTICE\n' > "$src_tree/NOTICE"
printf 'Applied fabdesk patch 24c847772e57ea8888e2cfe4bbf1aa00666390a4.patch\n' > "$src_tree/.fabdesk-macos-patch"

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
assert_contains "$ROOT/pack/linux-x86_64/LICENSE" "GPL-3.0-or-later"

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
    console.log("ok   parseTraceMakerManifest accepts packaged manifest");
  '
fi

if [ "$fail" -ne 0 ]; then
  echo "script tests failed"
  exit 1
fi
echo "all script tests passed"
