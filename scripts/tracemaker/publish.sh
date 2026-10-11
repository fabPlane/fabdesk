#!/usr/bin/env bash
# Create or complete the immutable fabdesk release and refresh tracemaker-latest.
# A partial release (e.g. Linux only) is completed by uploading missing platforms
# with --clobber and merging them into manifest.json after checksum-verifying
# the already-published archives.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"
# shellcheck source=platforms.sh
source "$SCRIPT_DIR/platforms.sh"

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

merge_dir="$(mktemp -d "${TMPDIR:-/tmp}/tm-publish.XXXXXX")"
trap 'rm -rf "$merge_dir"' EXIT

# Merge this run's asset.json files with any already-published platforms.
# New artifacts win. Existing entries are kept only after the archive downloads
# and its sha256 matches the previous manifest.
ARTIFACTS_DIR="$artifacts_dir" MERGE_DIR="$merge_dir" \
BUILT_AT="$built_at" UPSTREAM_REPO="$upstream_repo" \
UPSTREAM_TAG="$upstream_tag" UPSTREAM_COMMIT="$upstream_commit" \
SOURCE_URL="$source_url" EXPECTED="$TRACEMAKER_EXPECTED_PLATFORMS" \
python3 - <<'PY'
import json, os, pathlib
root = pathlib.Path(os.environ["ARTIFACTS_DIR"])
merge = pathlib.Path(os.environ["MERGE_DIR"])
local = []
for path in sorted(root.glob("*/asset.json")):
    local.append(json.loads(path.read_text(encoding="utf-8")))
(merge / "local.json").write_text(json.dumps(local, indent=2) + "\n", encoding="utf-8")
print("local platforms:", " ".join(sorted(a["platform"] for a in local)))
PY

existing_manifest=""
if gh release view "$release_tag" --repo "$repo" >/dev/null 2>&1; then
  if gh release download "$release_tag" --repo "$repo" --pattern manifest.json --dir "$merge_dir" 2>/dev/null \
    && [ -f "$merge_dir/manifest.json" ]; then
    existing_manifest="$merge_dir/manifest.json"
    echo "Loaded existing manifest from ${release_tag}"
  else
    echo "Existing ${release_tag} has no manifest.json; publishing only this run's assets."
  fi
fi

if [ -n "$existing_manifest" ]; then
  EXISTING="$existing_manifest" MERGE_DIR="$merge_dir" REPO="$repo" TAG="$release_tag" \
  ARTIFACTS_DIR="$artifacts_dir" python3 - <<'PY'
import json, os, pathlib, subprocess, sys, hashlib

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

merge = pathlib.Path(os.environ["MERGE_DIR"])
local = {a["platform"]: a for a in json.loads((merge / "local.json").read_text(encoding="utf-8"))}
existing = json.loads(pathlib.Path(os.environ["EXISTING"]).read_text(encoding="utf-8"))
kept = []
for asset in existing.get("assets", []):
    plat = asset.get("platform")
    if plat in local:
        print(f"this run replaces {plat}")
        continue
    filename = asset.get("filename")
    want = asset.get("sha256")
    if not filename or not want:
        print(f"::error::existing asset for {plat} is missing filename/sha256", file=sys.stderr)
        raise SystemExit(1)
    dest = merge / "kept"
    dest.mkdir(exist_ok=True)
    subprocess.run(
        ["gh", "release", "download", os.environ["TAG"], "--repo", os.environ["REPO"],
         "--pattern", filename, "--dir", str(dest)],
        check=True,
    )
    archive = dest / filename
    if not archive.is_file():
        print(f"::error::failed to download existing {filename} from {os.environ['TAG']}", file=sys.stderr)
        raise SystemExit(1)
    got = sha256(archive)
    if got != want:
        print(f"::error::checksum mismatch for existing {filename}: manifest {want} downloaded {got}", file=sys.stderr)
        raise SystemExit(1)
    print(f"verified existing {filename} ({plat})")
    kept.append(asset)
(merge / "kept.json").write_text(json.dumps(kept, indent=2) + "\n", encoding="utf-8")
PY
else
  echo '[]' > "$merge_dir/kept.json"
fi

ARTIFACTS_DIR="$artifacts_dir" MERGE_DIR="$merge_dir" BUILT_AT="$built_at" \
UPSTREAM_REPO="$upstream_repo" UPSTREAM_TAG="$upstream_tag" \
UPSTREAM_COMMIT="$upstream_commit" SOURCE_URL="$source_url" \
python3 - <<'PY'
import json, os, pathlib
root = pathlib.Path(os.environ["ARTIFACTS_DIR"])
merge = pathlib.Path(os.environ["MERGE_DIR"])
local = json.loads((merge / "local.json").read_text(encoding="utf-8"))
kept = json.loads((merge / "kept.json").read_text(encoding="utf-8"))
by_plat = {a["platform"]: a for a in kept}
for asset in local:
    by_plat[asset["platform"]] = asset
assets = [by_plat[k] for k in sorted(by_plat)]
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

Weekly TensorFleet build of [DingoOz/TraceMaker](https://github.com/${upstream_repo}) for fabdesk Settings → Routers.

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
macOS x86_64 is omitted (Intel runners are not cheap enough for a weekly job).
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

if gh release view "$release_tag" --repo "$repo" >/dev/null 2>&1; then
  echo "Completing existing ${release_tag} (clobber uploaded names)."
  gh release upload "$release_tag" "${uploads[@]}" --repo "$repo" --clobber
else
  gh release create "$release_tag" "${uploads[@]}" \
    --repo "$repo" \
    --title "TraceMaker ${upstream_tag} (${upstream_commit:0:7})" \
    --notes-file "$notes" \
    --latest=false
fi

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
