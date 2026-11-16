#!/usr/bin/env bash
# Mirror a published TraceMaker release (manifest + archives) to a public host.
# Unset or partial credentials print a notice and exit 0. When a channel is
# configured, a failed upload, a missing archive, or a sha256 mismatch exits
# non-zero. The private GitHub release is not rolled back either way.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

artifacts_dir="$(abs_existing_dir "${1:?artifacts directory with manifest.json}")"
release_tag="${TRACEMAKER_RELEASE_TAG:?}"
repo="${GITHUB_REPOSITORY:-fabPlane/fabdesk}"

notice() {
  echo "::notice::$1"
  echo "$1"
}

warn() {
  echo "::warning::$1"
  echo "$1"
}

manifest="$artifacts_dir/manifest.json"

# --- resolve public channel ------------------------------------------------
# Preferred: same R2 bucket as desktop installers (fabplane-downloads) under
# tracemaker/. Alternative: an owner-created public GitHub repo.
s3_bucket="${TRACEMAKER_S3_BUCKET:-}"
s3_endpoint="${TRACEMAKER_S3_ENDPOINT:-}"
s3_region="${TRACEMAKER_S3_REGION:-auto}"
s3_access="${TRACEMAKER_S3_ACCESS_KEY_ID:-}"
s3_secret="${TRACEMAKER_S3_SECRET_ACCESS_KEY:-}"
s3_prefix="${TRACEMAKER_S3_PREFIX:-tracemaker}"
public_base="${TRACEMAKER_PUBLIC_BASE_URL:-}"
public_repo="${TRACEMAKER_PUBLIC_RELEASE_REPO:-}"
public_token="${TRACEMAKER_PUBLIC_RELEASE_TOKEN:-}"

derived_desktop=0
if [ -z "$s3_access" ] || [ -z "$s3_secret" ] || [ -z "$s3_endpoint" ] || [ -z "$s3_bucket" ]; then
  desktop_id="${DESKTOP_R2_ACCESS_KEY_ID:-}"
  cf_account="${CLOUDFLARE_ACCOUNT_ID:-}"
  cf_token="${CLOUDFLARE_API_TOKEN:-}"
  if [ -n "$desktop_id" ] && [ -n "$cf_account" ] && [ -n "$cf_token" ]; then
    s3_access="$desktop_id"
    s3_secret="$(printf '%s' "$cf_token" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
    s3_endpoint="https://${cf_account}.r2.cloudflarestorage.com"
    s3_bucket="${s3_bucket:-fabplane-downloads}"
    s3_region="${s3_region:-auto}"
    derived_desktop=1
    if [ -z "$public_base" ]; then
      public_base="https://downloads.fabplane.com/tracemaker"
    fi
  fi
fi

have_s3=0
if [ -n "$s3_access" ] && [ -n "$s3_secret" ] && [ -n "$s3_endpoint" ] && [ -n "$s3_bucket" ] && [ -n "$public_base" ]; then
  have_s3=1
fi
have_repo=0
if [ -n "$public_repo" ] && [ -n "$public_token" ]; then
  have_repo=1
  if [ -z "$public_base" ]; then
    public_base="https://github.com/${public_repo}/releases/download"
  fi
fi

if [ "$have_s3" -eq 0 ] && [ "$have_repo" -eq 0 ]; then
  notice "Public TraceMaker mirror skipped: owner has not configured a public channel. GitHub release ${release_tag} on ${repo} is unchanged. Set TRACEMAKER_S3_* + TRACEMAKER_PUBLIC_BASE_URL (recommended: fabplane-downloads / https://downloads.fabplane.com/tracemaker) or TRACEMAKER_PUBLIC_RELEASE_REPO + TRACEMAKER_PUBLIC_RELEASE_TOKEN. Desktop R2 trio DESKTOP_R2_ACCESS_KEY_ID + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN is also accepted. See docs/routers.md."
  exit 0
fi

if [ ! -f "$manifest" ]; then
  warn "mirror-public: credentials are configured but no manifest.json in $artifacts_dir"
  exit 1
fi

# Every manifest archive must be on disk (flat `gh release download` or the
# nested artifact layout). A missing file would publish a manifest whose
# public URL 404s.
if ! MANIFEST="$manifest" ARTIFACTS="$artifacts_dir" python3 - <<'PY'
import json, os, pathlib, sys
manifest = json.loads(pathlib.Path(os.environ["MANIFEST"]).read_text(encoding="utf-8"))
root = pathlib.Path(os.environ["ARTIFACTS"])
missing = []
for asset in manifest.get("assets", []):
    name = asset.get("filename") if isinstance(asset, dict) else None
    if not name:
        missing.append("<unnamed>")
        continue
    found = [p for p in root.rglob(name) if p.is_file() and p.name == name]
    if not found:
        missing.append(str(name))
if missing:
    print("::error::mirror-public: missing archives: " + ", ".join(missing), file=sys.stderr)
    raise SystemExit(1)
print(f"mirror-public: found {len(manifest.get('assets', []))} manifest archives on disk")
PY
then
  warn "mirror-public: refusing to upload; a manifest archive is missing on disk"
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/tm-mirror.XXXXXX")"
trap 'rm -rf "$work"' EXIT

public_manifest="$work/manifest.json"
python3 "$SCRIPT_DIR/rewrite-public-manifest.py" "$manifest" \
  --base-url "$public_base" \
  --tag "$release_tag" \
  --out "$public_manifest"

# Latest pointer also uses the rewritten (versioned) asset URLs.
latest_manifest="$work/latest-manifest.json"
cp "$public_manifest" "$latest_manifest"

mirror_failed=0

upload_s3() {
  local file="$1" key="$2" cache="$3"
  TRACEMAKER_S3_ACCESS_KEY_ID="$s3_access" \
  TRACEMAKER_S3_SECRET_ACCESS_KEY="$s3_secret" \
  python3 "$SCRIPT_DIR/s3-put.py" \
    --file "$file" \
    --bucket "$s3_bucket" \
    --key "$key" \
    --endpoint "$s3_endpoint" \
    --region "$s3_region" \
    --path-style \
    --cache-control "$cache"
}

if [ "$have_s3" -eq 1 ]; then
  desktop_note=""
  if [ "$derived_desktop" -eq 1 ]; then
    desktop_note=" using desktop R2 credentials"
  fi
  echo "Mirroring to s3://$s3_bucket/${s3_prefix}/ (public base $public_base)${desktop_note}"
  while IFS= read -r archive; do
    [ -f "$archive" ] || continue
    name="$(basename "$archive")"
    if ! upload_s3 "$archive" "${s3_prefix}/${release_tag}/${name}" "public, max-age=31536000, immutable"; then
      warn "mirror-public: S3 upload failed for $name"
      mirror_failed=1
    fi
  done < <(find "$artifacts_dir" \( -name '*.tar.gz' -o -name '*.zip' \) -type f | sort)
  for extra in SHA256SUMS NOTES.md LICENSE SOURCE.txt; do
    if [ -f "$artifacts_dir/$extra" ]; then
      upload_s3 "$artifacts_dir/$extra" "${s3_prefix}/${release_tag}/${extra}" "public, max-age=31536000, immutable" \
        || { warn "mirror-public: S3 upload failed for $extra"; mirror_failed=1; }
    fi
  done
  upload_s3 "$public_manifest" "${s3_prefix}/${release_tag}/manifest.json" "public, max-age=300" \
    || { warn "mirror-public: S3 upload failed for ${release_tag}/manifest.json"; mirror_failed=1; }
  upload_s3 "$latest_manifest" "${s3_prefix}/tracemaker-latest/manifest.json" "public, max-age=300" \
    || { warn "mirror-public: S3 upload failed for tracemaker-latest/manifest.json"; mirror_failed=1; }
  if [ -f "$artifacts_dir/SHA256SUMS" ]; then
    upload_s3 "$artifacts_dir/SHA256SUMS" "${s3_prefix}/tracemaker-latest/SHA256SUMS" "public, max-age=300" \
      || { warn "mirror-public: S3 upload failed for tracemaker-latest/SHA256SUMS"; mirror_failed=1; }
  fi
fi

if [ "$have_repo" -eq 1 ]; then
  echo "Mirroring to public GitHub repo $public_repo"
  uploads=()
  while IFS= read -r archive; do
    [ -f "$archive" ] || continue
    uploads+=("$archive")
  done < <(find "$artifacts_dir" \( -name '*.tar.gz' -o -name '*.zip' \) -type f | sort)
  uploads+=("$public_manifest")
  [ -f "$artifacts_dir/SHA256SUMS" ] && uploads+=("$artifacts_dir/SHA256SUMS")
  [ -f "$artifacts_dir/NOTES.md" ] && uploads+=("$artifacts_dir/NOTES.md")
  [ -f "$artifacts_dir/LICENSE" ] && uploads+=("$artifacts_dir/LICENSE")
  [ -f "$artifacts_dir/SOURCE.txt" ] && uploads+=("$artifacts_dir/SOURCE.txt")
  GH_TOKEN="$public_token"
  export GH_TOKEN
  if gh release view "$release_tag" --repo "$public_repo" >/dev/null 2>&1; then
    gh release upload "$release_tag" "${uploads[@]}" --repo "$public_repo" --clobber \
      || { warn "mirror-public: public-repo upload failed for $release_tag"; mirror_failed=1; }
  else
    gh release create "$release_tag" "${uploads[@]}" \
      --repo "$public_repo" \
      --title "TraceMaker ${release_tag}" \
      --notes "Public mirror of ${repo} ${release_tag}. Source offer is SOURCE.txt in each archive." \
      --latest=false \
      || { warn "mirror-public: public-repo create failed for $release_tag"; mirror_failed=1; }
  fi
  pointer=("$latest_manifest")
  [ -f "$artifacts_dir/SHA256SUMS" ] && pointer+=("$artifacts_dir/SHA256SUMS")
  [ -f "$artifacts_dir/NOTES.md" ] && pointer+=("$artifacts_dir/NOTES.md")
  if gh release view tracemaker-latest --repo "$public_repo" >/dev/null 2>&1; then
    gh release delete tracemaker-latest --repo "$public_repo" --yes --cleanup-tag || true
  fi
  # Rename latest pointer manifest back to the expected filename.
  cp "$latest_manifest" "$work/manifest.json"
  pointer=("$work/manifest.json")
  [ -f "$artifacts_dir/SHA256SUMS" ] && pointer+=("$artifacts_dir/SHA256SUMS")
  [ -f "$artifacts_dir/NOTES.md" ] && pointer+=("$artifacts_dir/NOTES.md")
  gh release create tracemaker-latest "${pointer[@]}" \
    --repo "$public_repo" \
    --title "TraceMaker binaries (latest → ${release_tag})" \
    --notes "Rolling pointer. Asset URLs are public." \
    --latest=false \
    || { warn "mirror-public: public-repo latest pointer failed"; mirror_failed=1; }
fi

# Re-download every rewritten asset and compare sha256 to the private manifest.
# Also require tracemaker-latest/manifest.json to match the bytes we uploaded.
export TRACEMAKER_PUBLIC_BASE_URL="$public_base"
if [ "$mirror_failed" -eq 0 ]; then
  if ! PUBLIC_MANIFEST="$public_manifest" WORK="$work/verify" python3 - <<'PY'
import json, os, pathlib, subprocess, sys
manifest_path = pathlib.Path(os.environ["PUBLIC_MANIFEST"])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
uploaded = manifest_path.read_bytes()
work = pathlib.Path(os.environ["WORK"])
work.mkdir(parents=True, exist_ok=True)
failed = 0
for asset in manifest.get("assets", []):
    url = asset.get("url") if isinstance(asset, dict) else None
    want = asset.get("sha256") if isinstance(asset, dict) else None
    name = asset.get("filename") if isinstance(asset, dict) else None
    if not url or not want or not name:
        print("::warning::mirror-public: asset missing url/sha256/filename", file=sys.stderr)
        failed = 1
        continue
    dest = work / name
    rc = subprocess.run(["curl", "-fsSL", "--retry", "3", "--retry-delay", "2", url, "-o", str(dest)]).returncode
    if rc != 0:
        print(f"::warning::mirror-public: failed to re-download {url}", file=sys.stderr)
        failed = 1
        continue
    proc = subprocess.run(["sha256sum", str(dest)], capture_output=True, text=True)
    if proc.returncode != 0:
        proc = subprocess.run(["shasum", "-a", "256", str(dest)], capture_output=True, text=True)
    parts = (proc.stdout or "").split()
    got = parts[0] if proc.returncode == 0 and parts else ""
    if got != want:
        print(f"::warning::mirror-public: checksum mismatch for {url}: manifest {want} downloaded {got}", file=sys.stderr)
        failed = 1
    else:
        print(f"verified public {name} sha256 {got}")
latest = f"{os.environ.get('TRACEMAKER_PUBLIC_BASE_URL', '').rstrip('/')}/tracemaker-latest/manifest.json"
if latest.startswith("http"):
    dest = work / "latest-manifest.json"
    rc = subprocess.run(["curl", "-fsSL", "--retry", "3", latest, "-o", str(dest)]).returncode
    if rc != 0 or not dest.is_file():
        print(f"::warning::mirror-public: failed to re-download {latest}", file=sys.stderr)
        failed = 1
    elif dest.read_bytes() != uploaded:
        print(f"::warning::mirror-public: latest manifest bytes differ from upload at {latest}", file=sys.stderr)
        failed = 1
    else:
        print(f"verified public latest manifest at {latest}")
raise SystemExit(failed)
PY
  then
    warn "mirror-public: post-upload checksum verification failed; private GitHub release ${release_tag} was not rolled back"
    mirror_failed=1
  fi
fi

if [ "$mirror_failed" -eq 0 ]; then
  echo "Public TraceMaker mirror is live at ${public_base}/tracemaker-latest/manifest.json"
  exit 0
fi
warn "Public mirror failed (upload or checksum). The private GitHub release ${release_tag} was not rolled back."
exit 1
