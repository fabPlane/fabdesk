#!/usr/bin/env bash
# One-off (2026-11-18): point the public tracemaker-latest/manifest.json back at the immutable v0.12.1-db5950f manifest.
# A partial build (Linux only) replaced it; main's app reads it. Same credential rules as mirror-public.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
want_sha="9a194b1f16fa9570c4a9da0daa1aef41dd115968ba5f8135132f5b0edafc58a6"
s3_bucket="${TRACEMAKER_S3_BUCKET:-}"; s3_endpoint="${TRACEMAKER_S3_ENDPOINT:-}"; s3_region="${TRACEMAKER_S3_REGION:-auto}"
s3_access="${TRACEMAKER_S3_ACCESS_KEY_ID:-}"; s3_secret="${TRACEMAKER_S3_SECRET_ACCESS_KEY:-}"
s3_prefix="${TRACEMAKER_S3_PREFIX:-tracemaker}"; public_base="${TRACEMAKER_PUBLIC_BASE_URL:-}"
if [ -z "$s3_access" ] || [ -z "$s3_secret" ] || [ -z "$s3_endpoint" ] || [ -z "$s3_bucket" ]; then
  s3_access="${DESKTOP_R2_ACCESS_KEY_ID:?no S3 or desktop R2 credentials}"
  s3_secret="$(printf '%s' "${CLOUDFLARE_API_TOKEN:?}" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
  s3_endpoint="https://${CLOUDFLARE_ACCOUNT_ID:?}.r2.cloudflarestorage.com"
  s3_bucket="${s3_bucket:-fabplane-downloads}"
  public_base="${public_base:-https://downloads.fabplane.com/tracemaker}"
fi
: "${public_base:?no public base URL}"
work="$(mktemp -d)"
curl -fsSL --retry 3 "${public_base%/}/tracemaker-v0.12.1-db5950f/manifest.json" -o "$work/manifest.json"
got="$(sha256sum "$work/manifest.json" | cut -d' ' -f1)"
[ "$got" = "$want_sha" ] || { echo "::error::versioned manifest sha256 $got, expected $want_sha" >&2; exit 1; }
TRACEMAKER_S3_ACCESS_KEY_ID="$s3_access" TRACEMAKER_S3_SECRET_ACCESS_KEY="$s3_secret" \
  python3 "$SCRIPT_DIR/s3-put.py" --file "$work/manifest.json" --bucket "$s3_bucket" \
  --key "${s3_prefix}/tracemaker-latest/manifest.json" --endpoint "$s3_endpoint" --region "$s3_region" \
  --path-style --cache-control "public, max-age=300" --content-type application/json
sleep 5
curl -fsSL --retry 3 -H 'Cache-Control: no-cache' "${public_base%/}/tracemaker-latest/manifest.json?restore=$(date +%s)" -o "$work/check.json"
cmp -s "$work/manifest.json" "$work/check.json" || { echo "::error::public latest manifest does not match after restore" >&2; exit 1; }
echo "restored ${public_base%/}/tracemaker-latest/manifest.json to tracemaker-v0.12.1-db5950f (sha256 $want_sha)"
