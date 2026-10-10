#!/usr/bin/env bash
# Apply a commit-pinned Windows patch when HEAD matches a known upstream SHA.
# Linux and macOS builds do not run this script, so their trees stay
# byte-for-byte identical to the unpatched (or macOS-patched) sources.
# v0.9.0 on MSYS2 UCRT64 (run 38075992766): M_PI in escape.cpp, and
# wchar_t filesystem paths in viewer_server.cpp.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

src="$(abs_existing_dir "${1:?TraceMaker source tree}")"
note="$src/.fabdesk-windows-patch"

if ! git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "No git metadata in $src; skipping Windows patch."
  rm -f "$note"
  exit 0
fi

commit="$(git -C "$src" rev-parse HEAD)"
patch="$SCRIPT_DIR/patches/${commit}-windows.patch"

if [ ! -f "$patch" ]; then
  echo "No commit-pinned Windows patch for $commit."
  rm -f "$note"
  exit 0
fi

echo "Applying $patch to $src ($commit)"
if ! git -C "$src" apply --check "$patch"; then
  echo "::error::patch $patch does not apply to $commit" >&2
  exit 1
fi
git -C "$src" apply "$patch"

{
  echo "Applied fabdesk Windows patch ${patch##*/} (GPL-3.0-or-later corresponding source:"
  echo "upstream commit $commit plus this patch in TensorFleet/fabdesk"
  echo "scripts/tracemaker/patches/${commit}-windows.patch)."
  echo "MinGW UCRT64: std::numbers::pi in escape.cpp; filesystem::path::string() in viewer_server.cpp."
} > "$note"
echo "Wrote $note"
