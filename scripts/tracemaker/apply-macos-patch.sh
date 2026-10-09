#!/usr/bin/env bash
# Apply a commit-pinned macOS patch when HEAD matches a known upstream SHA.
# Covers Apple libc++ from_chars(double) (missing before macOS 26) and
# Homebrew LLVM libc++ missing <cstdlib> for std::atof / std::atoi.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$SCRIPT_DIR/paths.sh"

src="$(abs_existing_dir "${1:?TraceMaker source tree}")"
commit="$(git -C "$src" rev-parse HEAD)"
patch="$SCRIPT_DIR/patches/${commit}.patch"
note="$src/.fabdesk-macos-patch"

if [ ! -f "$patch" ]; then
  echo "No commit-pinned macOS patch for $commit (LLVM libc++ must provide from_chars(double))."
  rm -f "$note"
  exit 0
fi

echo "Applying $patch to $src ($commit)"
if ! git -C "$src" apply --check "$patch"; then
  echo "::error::patch $patch does not apply to $commit" >&2
  exit 1
fi
git -C "$src" apply "$patch"

# Helper comments mention from_chars(double); ignore that file. Integer
# from_chars is fine on Apple libc++ — only double/float sites were patched.
sites="$(grep -R -n --include='*.cpp' --include='*.hpp' --exclude='from_chars_double.hpp' 'std::from_chars(' "$src/src" || true)"
if [ -n "$sites" ]; then
  echo "::warning::std::from_chars( still present after the patch:"
  printf '%s\n' "$sites"
fi

{
  echo "Applied fabdesk patch ${patch##*/} (GPL-3.0-or-later corresponding source:"
  echo "upstream commit $commit plus this patch in TensorFleet/fabdesk"
  echo "scripts/tracemaker/patches/${commit}.patch)."
} > "$note"
echo "Wrote $note"
