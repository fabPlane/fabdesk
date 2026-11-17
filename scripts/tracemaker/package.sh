#!/usr/bin/env bash
# Pack the binaries (tracemaker + its placer tracemaker-place) + GPL license +
# pinned source offer for one platform. Placer: 4th argument, else beside the
# binary / in its build tree (src/place). Both get the same strip, library
# bundling, Windows DLL probe and macOS ad-hoc signature.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

binary="$(abs_existing_file "${1:?built tracemaker binary}")"
platform="${2:?platform id}"
dest_dir="$(abs_path "${3:?output directory}")"
placer="${4:-}"
if [ -n "$placer" ]; then
  placer="$(abs_existing_file "$placer")"
elif ! placer="$(find_placer "$binary" "$platform")"; then
  echo "::error::no tracemaker-place beside $binary or in its build tree: board_route's floorplan path needs it in the archive" >&2
  exit 1
fi
upstream_repo="${TRACEMAKER_UPSTREAM_REPO:-DingoOz/TraceMaker}"
upstream_tag="${TRACEMAKER_UPSTREAM_TAG:?}"
upstream_commit="${TRACEMAKER_UPSTREAM_COMMIT:?}"
source_url="${TRACEMAKER_SOURCE_URL:?}"
src_tree="${TRACEMAKER_SRC:-}"
built_at="${TRACEMAKER_BUILT_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
release_tag="${TRACEMAKER_RELEASE_TAG:?}"
repo="${GITHUB_REPOSITORY:-fabPlane/fabdesk}"

if [ -n "$src_tree" ]; then
  src_tree="$(abs_existing_dir "$src_tree")"
fi

mkdir -p "$dest_dir"
work="$(mktemp -d "${TMPDIR:-/tmp}/tm-pack.XXXXXX")"
trap 'rm -rf "$work"' EXIT

exe_name="tracemaker"
placer_name="tracemaker-place"
if [[ "$platform" == windows-* ]]; then
  exe_name="tracemaker.exe"
  placer_name="tracemaker-place.exe"
fi
cp "$binary" "$work/$exe_name"
cp "$placer" "$work/$placer_name"
for exe in "$exe_name" "$placer_name"; do
  chmod 755 "$work/$exe" || true
  if command -v strip >/dev/null; then
    strip "$work/$exe" || true
  fi
done

if [ -n "$src_tree" ] && [ -f "$src_tree/LICENSE" ]; then
  cp "$src_tree/LICENSE" "$work/LICENSE"
else
  curl -fsSL "https://raw.githubusercontent.com/${upstream_repo}/${upstream_commit}/LICENSE" -o "$work/LICENSE"
fi
if [ -n "$src_tree" ] && [ -f "$src_tree/NOTICE" ]; then
  cp "$src_tree/NOTICE" "$work/NOTICE"
else
  curl -fsSL "https://raw.githubusercontent.com/${upstream_repo}/${upstream_commit}/NOTICE" -o "$work/NOTICE"
fi
if [ ! -f "$work/NOTICE" ]; then
  echo "::error::NOTICE is required in the TraceMaker archive" >&2
  exit 1
fi

notes="$work/DEPENDENCIES.txt"
{
  echo "TraceMaker ${upstream_tag} (${upstream_commit})"
  echo "Built by ${repo} for ${platform} at ${built_at}."
  echo
  echo "Programs: ${exe_name} (router) and ${placer_name} (placer, used by board_route's floorplan path)."
  echo "This is a cpu-only / Metal build. CUDA is not included; users do not need nvcc or a GPU."
  echo "Boost, Eigen, CLI11 and nlohmann_json are header-only at link time."
  if [[ "$platform" == macos-* ]]; then
    macos_libcxx="llvm-static"
    if [ -n "$src_tree" ] && [ -f "$src_tree/.fabdesk-macos-libcxx" ]; then
      macos_libcxx="$(tr -d '[:space:]' < "$src_tree/.fabdesk-macos-libcxx")"
    fi
    if [ "$macos_libcxx" = system ]; then
      echo "macOS variant A: Apple clang + system /usr/lib/libc++.1.dylib; static libzstd.a;"
    else
      echo "macOS variant B: Homebrew LLVM static libc++ / libc++abi / libunwind; static libzstd.a;"
    fi
    echo "SQLite is static libsqlite3.a or /usr/lib/libsqlite3.dylib; minos 15.0."
    echo "No Homebrew dylibs (zstd/sqlite). Metal + Foundation + libobjc + libSystem."
    echo "Published cxxRuntime=${macos_libcxx}."
  fi
  if [[ "$platform" == windows-* ]]; then
    echo "Windows best-effort: MSYS2 UCRT64 MinGW, static libgcc/libstdc++,"
    echo "static libzstd.a, static libsqlite3.a when present. Remaining"
    echo "non-system DLLs are copied next to the .exe files (Windows loads"
    echo "the executable directory). CUDA is not included."
  fi
  echo
} > "$notes"
for exe in "$exe_name" "$placer_name"; do
  if [[ "$platform" == windows-* ]]; then
    bash "$SCRIPT_DIR/bundle-libs.sh" "$work/$exe" "$work" "$notes"
  else
    bash "$SCRIPT_DIR/bundle-libs.sh" "$work/$exe" "$work/lib" "$notes"
  fi
done

# strip + install_name_tool invalidate any signature. Ad-hoc sign so the
# arm64 binary is runnable on Gatekeeper-ish CI and owner Macs (no identity).
if [[ "$platform" == macos-* ]] && command -v codesign >/dev/null; then
  for exe in "$exe_name" "$placer_name"; do
    codesign --force -s - "$work/$exe"
    echo "ad-hoc codesign -s - $exe" | tee -a "$notes"
  done
fi

patch_note=""
if [ -n "$src_tree" ] && [ -f "$src_tree/.fabdesk-macos-patch" ]; then
  patch_note="$(cat "$src_tree/.fabdesk-macos-patch")"
fi
link_note=""
if [ -n "$src_tree" ] && [ -f "$src_tree/.fabdesk-macos-link" ]; then
  link_note="$(cat "$src_tree/.fabdesk-macos-link")"
fi
if [ -n "$src_tree" ] && [ -f "$src_tree/.fabdesk-windows-link" ]; then
  if [ -n "$link_note" ]; then
    link_note="${link_note}
$(cat "$src_tree/.fabdesk-windows-link")"
  else
    link_note="$(cat "$src_tree/.fabdesk-windows-link")"
  fi
fi
if [ -n "$src_tree" ] && [ -f "$src_tree/.fabdesk-windows-patch" ]; then
  if [ -n "$patch_note" ]; then
    patch_note="${patch_note}
$(cat "$src_tree/.fabdesk-windows-patch")"
  else
    patch_note="$(cat "$src_tree/.fabdesk-windows-patch")"
  fi
fi

# Retain pristine upstream source plus the exact tracked changes applied by the
# build (including platform patches). Source is both in the binary archive and
# beside it on the immutable public release, so upstream availability is irrelevant.
[ -n "$src_tree" ] || { echo "TRACEMAKER_SRC is required for corresponding source" >&2; exit 1; }
source_name="tracemaker-source-${platform}.tar.gz"
source_dir="$work/corresponding-source"
mkdir -p "$source_dir"
git -C "$src_tree" archive --format=tar.gz "$upstream_commit" > "$source_dir/upstream.tar.gz"
git -C "$src_tree" diff --binary "$upstream_commit" > "$source_dir/build.patch"
cp -R "$SCRIPT_DIR" "$source_dir/build-scripts"
runtime=system
if [ -f "$src_tree/.fabdesk-macos-libcxx" ]; then runtime="$(cat "$src_tree/.fabdesk-macos-libcxx")"; fi
TRACEMAKER_LINK_NOTE="$link_note" bash "$SCRIPT_DIR/collect-sources.sh" "$platform" "$source_dir/dependencies" "$runtime"
cp "${TRACEMAKER_WORKFLOW_PATH:-$SCRIPT_DIR/../../.github/workflows/tracemaker-binaries.yml}" "$source_dir/dependency-install-workflow.yml"
tar -czf "$dest_dir/$source_name" -C "$source_dir" .
source_sha="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$dest_dir/$source_name")"
runtime=system
if [ -f "$src_tree/.fabdesk-macos-libcxx" ]; then runtime="$(cat "$src_tree/.fabdesk-macos-libcxx")"; fi
TRACEMAKER_LINK_NOTE="$link_note" bash "$SCRIPT_DIR/collect-licenses.sh" "$platform" "$work/licenses" "$runtime"
source_body="Unofficial binary built by ${repo}. The corresponding source is included in
corresponding-source/ (upstream.tar.gz, build.patch, build-scripts/, dependencies/ and dependency-install-workflow.yml).
Apply build.patch to the extracted upstream tree before building.
${patch_note}
${link_note}"

cat > "$work/SOURCE.txt" <<EOF
TraceMaker
License: GPL-3.0-or-later (see LICENSE in this archive; NOTICE if present)

${source_body}
The workflow is .github/workflows/tracemaker-binaries.yml in ${repo}.

Upstream repository: https://github.com/${upstream_repo}
Upstream tag: ${upstream_tag}
Upstream commit: ${upstream_commit}
Our corresponding-source copy: https://downloads.fabplane.com/tracemaker/${release_tag}/${source_name}
Source copy sha256: ${source_sha}
Upstream source tarball (commit): ${source_url}
Source tarball (tag): https://github.com/${upstream_repo}/archive/refs/tags/${upstream_tag}.tar.gz

Platform: ${platform}
Build date (UTC): ${built_at}
EOF

# Info-ZIP when it is installed. Self-hosted Linux verify has no `zip`, and
# MSYS2 UCRT64 may only have `python`/`python3`, so fall back to the stdlib
# zipfile CLI. Names stay at the archive root (tracemaker.exe, LICENSE, …).
pack_windows_zip() {
  local archive="$1" workdir="$2" py
  if command -v zip >/dev/null 2>&1; then
    echo "packaging $(basename "$archive") with zip"
    (cd "$workdir" && zip -r "$archive" .)
    return 0
  fi
  py=""
  if command -v python3 >/dev/null 2>&1; then
    py="python3"
  elif command -v python >/dev/null 2>&1; then
    py="python"
  fi
  if [ -z "$py" ]; then
    echo "::error::windows zip packaging needs 'zip' or python3 (python3 -m zipfile)" >&2
    exit 1
  fi
  echo "packaging $(basename "$archive") with ${py} -m zipfile (zip not on PATH)"
  (cd "$workdir" && "$py" -m zipfile -c "$archive" .)
}

archive_name="tracemaker-${platform}"
if [[ "$platform" == windows-* ]]; then
  bash "$SCRIPT_DIR/verify-windows.sh" "$work/$exe_name"
  bash "$SCRIPT_DIR/verify-windows.sh" "$work/$placer_name"
  archive="${dest_dir}/${archive_name}.zip"
  pack_windows_zip "$archive" "$work"
  format="zip"
else
  archive="${dest_dir}/${archive_name}.tar.gz"
  tar -czf "$archive" -C "$work" .
  format="tar.gz"
fi

if command -v sha256sum >/dev/null; then
  sha="$(sha256sum "$archive" | awk '{print $1}')"
else
  sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
bytes="$(wc -c < "$archive" | tr -d ' ')"
filename="$(basename "$archive")"
asset_url="https://github.com/${repo}/releases/download/${release_tag}/${filename}"

cxx_runtime=""
macos_variant=""
if [[ "$platform" == macos-* ]]; then
  cxx_runtime="llvm-static"
  if [ -n "$src_tree" ] && [ -f "$src_tree/.fabdesk-macos-libcxx" ]; then
    cxx_runtime="$(tr -d '[:space:]' < "$src_tree/.fabdesk-macos-libcxx")"
  fi
  macos_variant="$cxx_runtime"
fi

PLATFORM="$platform" FILENAME="$filename" ASSET_URL="$asset_url" SHA="$sha" \
BYTES="$bytes" FORMAT="$format" EXE_NAME="$exe_name" PLACER_NAME="$placer_name" NOTES="$notes" DEST_DIR="$dest_dir" \
CXX_RUNTIME="$cxx_runtime" MACOS_VARIANT="$macos_variant" \
python3 - <<'PY'
import json, os, pathlib
asset = {
  "platform": os.environ["PLATFORM"],
  "filename": os.environ["FILENAME"],
  "url": os.environ["ASSET_URL"],
  "sha256": os.environ["SHA"],
  "bytes": int(os.environ["BYTES"]),
  "format": os.environ["FORMAT"],
  "executable": os.environ["EXE_NAME"],
  # The placer sits beside the executable; the installer and resolve-upstream.sh
  # read this key (an asset without it predates the placer and is rebuilt).
  "placer": os.environ["PLACER_NAME"],
}
notes = pathlib.Path(os.environ["NOTES"]).read_text(encoding="utf-8")
asset["linkage"] = (
    "bundled-non-system-libs"
    if any(line.startswith("bundled ") for line in notes.splitlines())
    else "system-libc-or-frameworks"
)
if os.environ["PLATFORM"].startswith("macos-"):
    asset["minos"] = "15.0"
    if os.environ.get("CXX_RUNTIME"):
        asset["cxxRuntime"] = os.environ["CXX_RUNTIME"]
    if os.environ.get("MACOS_VARIANT"):
        asset["macosVariant"] = os.environ["MACOS_VARIANT"]
path = pathlib.Path(os.environ["DEST_DIR"]) / "asset.json"
path.write_text(json.dumps(asset, indent=2) + "\n", encoding="utf-8")
print(json.dumps(asset, indent=2))
PY

printf '%s  %s\n' "$sha" "$filename" > "${dest_dir}/SHA256SUMS"
cp "$work/LICENSE" "$dest_dir/LICENSE"
cp "$work/SOURCE.txt" "$dest_dir/SOURCE.txt"
cp "$work/DEPENDENCIES.txt" "$dest_dir/DEPENDENCIES.txt"
if [ -f "$work/NOTICE" ]; then
  cp "$work/NOTICE" "$dest_dir/NOTICE"
fi
echo "Packed $archive ($bytes bytes, sha256 $sha)"
