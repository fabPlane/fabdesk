#!/usr/bin/env bash
# Pack the binary + GPL license + pinned source offer for one platform.
set -euo pipefail

binary="${1:?built tracemaker binary}"
platform="${2:?platform id}"
dest_dir="${3:?output directory}"
upstream_repo="${TRACEMAKER_UPSTREAM_REPO:-DingoOz/TraceMaker}"
upstream_tag="${TRACEMAKER_UPSTREAM_TAG:?}"
upstream_commit="${TRACEMAKER_UPSTREAM_COMMIT:?}"
source_url="${TRACEMAKER_SOURCE_URL:?}"
src_tree="${TRACEMAKER_SRC:-}"
built_at="${TRACEMAKER_BUILT_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
release_tag="${TRACEMAKER_RELEASE_TAG:?}"
repo="${GITHUB_REPOSITORY:-TensorFleet/fabdesk}"

mkdir -p "$dest_dir"
work="$(mktemp -d "${TMPDIR:-/tmp}/tm-pack.XXXXXX")"
trap 'rm -rf "$work"' EXIT

exe_name="tracemaker"
if [[ "$platform" == windows-* ]]; then
  exe_name="tracemaker.exe"
fi
cp "$binary" "$work/$exe_name"
chmod 755 "$work/$exe_name" || true
if command -v strip >/dev/null && [[ "$platform" != windows-* ]]; then
  strip "$work/$exe_name" || true
fi

if [ -n "$src_tree" ] && [ -f "$src_tree/LICENSE" ]; then
  cp "$src_tree/LICENSE" "$work/LICENSE"
else
  curl -fsSL "https://raw.githubusercontent.com/${upstream_repo}/${upstream_commit}/LICENSE" -o "$work/LICENSE"
fi
if [ -n "$src_tree" ] && [ -f "$src_tree/NOTICE" ]; then
  cp "$src_tree/NOTICE" "$work/NOTICE"
else
  curl -fsSL "https://raw.githubusercontent.com/${upstream_repo}/${upstream_commit}/NOTICE" -o "$work/NOTICE" || true
fi

notes="$work/DEPENDENCIES.txt"
{
  echo "TraceMaker ${upstream_tag} (${upstream_commit})"
  echo "Built by ${repo} for ${platform} at ${built_at}."
  echo
  echo "This is a cpu-only / Metal build. CUDA is not included; users do not need nvcc or a GPU."
  echo "Boost, Eigen, CLI11 and nlohmann_json are header-only at link time."
  echo
} > "$notes"
bash "$(dirname "$0")/bundle-libs.sh" "$work/$exe_name" "$work/lib" "$notes"

cat > "$work/SOURCE.txt" <<EOF
TraceMaker
License: GPL-3.0-or-later (see LICENSE in this archive; NOTICE if present)

This archive is a binary built by ${repo} from unmodified upstream sources.
Corresponding complete source is the exact commit below (GPL-3.0 §6 network
source offer). TensorFleet did not patch the C++ tree for this build; the
workflow is .github/workflows/tracemaker-binaries.yml in ${repo}.

Upstream repository: https://github.com/${upstream_repo}
Upstream tag: ${upstream_tag}
Upstream commit: ${upstream_commit}
Source tarball (commit): ${source_url}
Source tarball (tag): https://github.com/${upstream_repo}/archive/refs/tags/${upstream_tag}.tar.gz

Platform: ${platform}
Build date (UTC): ${built_at}
EOF

archive_name="tracemaker-${platform}"
if [[ "$platform" == windows-* ]]; then
  archive="${dest_dir}/${archive_name}.zip"
  (cd "$work" && zip -r "$archive" .)
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

PLATFORM="$platform" FILENAME="$filename" ASSET_URL="$asset_url" SHA="$sha" \
BYTES="$bytes" FORMAT="$format" EXE_NAME="$exe_name" NOTES="$notes" DEST_DIR="$dest_dir" \
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
}
notes = pathlib.Path(os.environ["NOTES"]).read_text(encoding="utf-8")
asset["linkage"] = "bundled-non-system-libs" if "bundled" in notes else "system-libc-or-frameworks"
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
