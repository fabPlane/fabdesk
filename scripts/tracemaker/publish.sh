#!/usr/bin/env bash
# Create a new immutable build release and refresh tracemaker-latest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

artifacts_dir="$(abs_existing_dir "${1:?artifacts directory}")"
repo="${GITHUB_REPOSITORY:?}"
release_tag="${TRACEMAKER_RELEASE_TAG:?}"
upstream_repo="${TRACEMAKER_UPSTREAM_REPO:-DingoOz/TraceMaker}"
upstream_tag="${TRACEMAKER_UPSTREAM_TAG:?}"
upstream_commit="${TRACEMAKER_UPSTREAM_COMMIT:?}"
source_url="${TRACEMAKER_SOURCE_URL:?}"
built_at="${TRACEMAKER_BUILT_AT:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
: "${GH_TOKEN:?GH_TOKEN or GITHUB_TOKEN is required}"

shopt -s nullglob
assets=("$artifacts_dir"/*/asset.json)
if [ ${#assets[@]} -eq 0 ]; then
  echo "::error::No platform asset.json files — every matrix cell failed or was skipped." >&2
  exit 1
fi

python3 "$SCRIPT_DIR/check-archive.py" "$artifacts_dir"

# Build this run's manifest only. An existing release is an error, never a
# source of retained platforms or replacement uploads.
ARTIFACTS_DIR="$artifacts_dir" BUILT_AT="$built_at" \
UPSTREAM_REPO="$upstream_repo" UPSTREAM_TAG="$upstream_tag" \
UPSTREAM_COMMIT="$upstream_commit" SOURCE_URL="$source_url" \
python3 - <<'PY'
import json, os, pathlib
root = pathlib.Path(os.environ["ARTIFACTS_DIR"])
by_platform = {}
for path in sorted(root.glob("*/asset.json")):
    asset = json.loads(path.read_text(encoding="utf-8"))
    by_platform[asset["platform"]] = asset
assets = [by_platform[platform] for platform in sorted(by_platform)]
manifest = {
    "name": "tracemaker",
    "builtAt": os.environ["BUILT_AT"],
    "upstream": {
        "repository": f"https://github.com/{os.environ['UPSTREAM_REPO']}",
        "tag": os.environ["UPSTREAM_TAG"],
        "commit": os.environ["UPSTREAM_COMMIT"],
        "license": "GPL-3.0-or-later",
        "sourceUrl": os.environ["SOURCE_URL"],
    },
    "assets": assets,
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
(root / "SHA256SUMS").write_text("".join(f"{a['sha256']}  {a['filename']}\n" for a in assets), encoding="utf-8")
print(json.dumps(manifest, indent=2))
PY

# Copy a license/source offer next to the manifest so the pointer release stays complete.
# Search only platform artifact dirs (mindepth 2). A second publish of the same
# folder already has LICENSE/SOURCE.txt at the root; GNU cp errors on same-file
# (ubuntu-latest, CI run 38015352358).
copy_unless_same() {
  local src="${1:-}" dest="$2"
  if [ -z "$src" ] || [ ! -f "$src" ]; then
    return 0
  fi
  if [ -e "$dest" ] && [ "$src" -ef "$dest" ]; then
    return 0
  fi
  cp "$src" "$dest"
}
license_src="$(find "$artifacts_dir" -mindepth 2 -name LICENSE -type f | head -n 1 || true)"
source_src="$(find "$artifacts_dir" -mindepth 2 -name SOURCE.txt -type f | head -n 1 || true)"
copy_unless_same "$license_src" "$artifacts_dir/LICENSE"
copy_unless_same "$source_src" "$artifacts_dir/SOURCE.txt"

notes="$artifacts_dir/NOTES.md"
cat > "$notes" <<EOF
# TraceMaker ${upstream_tag} (${upstream_commit:0:7})

Unofficial fabPlane/fabdesk build of [DingoOz/TraceMaker](https://github.com/${upstream_repo}) for fabdesk Settings → Routers.

## GPL-3.0-or-later

Each archive contains the upstream \`LICENSE\` (and \`NOTICE\` when present) plus \`SOURCE.txt\`
with the pinned commit. Corresponding source:

- ${source_url}
- https://github.com/${upstream_repo}/archive/refs/tags/${upstream_tag}.tar.gz

macOS builds may apply a commit-pinned from_chars(double) patch (Apple libc++
before macOS 26); that patch is listed in each archive's \`SOURCE.txt\` when used.
Linux builds are unmodified upstream. The recipe is
\`.github/workflows/tracemaker-binaries.yml\`.

## Assets

See \`manifest.json\` (platform, sha256, size, upstream tag/commit, build date).
\`tracemaker-latest\` is a rolling pointer at this same immutable tag.

CUDA is not included (cpu-only on Linux, Metal on macOS, cpu-only MinGW on Windows).
macOS x86_64 is omitted (Intel runners are not cheap enough for a manual build).
Windows is best-effort: a failed windows-x86_64 job leaves linux/macos published
and is reported in the run summary.
EOF

uploads=()
for archive in "$artifacts_dir"/*/*.tar.gz "$artifacts_dir"/*/*.zip; do
  uploads+=("$archive")
done
uploads+=("$artifacts_dir/manifest.json" "$artifacts_dir/SHA256SUMS" "$artifacts_dir/NOTES.md")
[ -f "$artifacts_dir/LICENSE" ] && uploads+=("$artifacts_dir/LICENSE")
[ -f "$artifacts_dir/SOURCE.txt" ] && uploads+=("$artifacts_dir/SOURCE.txt")

gh release create "$release_tag" "${uploads[@]}" \
  --repo "$repo" --title "TraceMaker ${upstream_tag} (${upstream_commit:0:7})" \
  --notes-file "$notes" --latest=false

# Rolling pointer: manifest (+ license/source offer) only, URLs already point at the immutable tag.
if gh release view tracemaker-latest --repo "$repo" >/dev/null 2>&1; then
  gh release delete tracemaker-latest --repo "$repo" --yes --cleanup-tag
fi
pointer=("$artifacts_dir/manifest.json" "$artifacts_dir/SHA256SUMS" "$artifacts_dir/NOTES.md")
[ -f "$artifacts_dir/LICENSE" ] && pointer+=("$artifacts_dir/LICENSE")
[ -f "$artifacts_dir/SOURCE.txt" ] && pointer+=("$artifacts_dir/SOURCE.txt")
gh release create tracemaker-latest "${pointer[@]}" \
  --repo "$repo" \
  --title "TraceMaker binaries (latest → ${release_tag})" \
  --notes-file "$notes" \
  --latest=false

echo "Published ${release_tag} and updated tracemaker-latest"
