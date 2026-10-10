#!/usr/bin/env bash
# Apply a commit-pinned Windows patch when HEAD matches a known upstream SHA.
# Linux and macOS builds do not run this script, so their trees stay
# byte-for-byte identical to the unpatched (or macOS-patched) sources.
# v0.9.0 on MSYS2 UCRT64 (run 38075992766): M_PI in escape.cpp, and
# wchar_t filesystem paths in viewer_server.cpp.
#
# Run 38082482176 (windows-x86_64, job 114302116824): Git for Windows
# (C:\Program Files\Git\bin\git.exe, core.autocrlf defaults to true) checked
# out DingoOz/TraceMaker with no .gitattributes, so working-tree sources
# became CRLF. The LF patch (gitattributes eol=lf) then failed with
#   error: patch failed: src/route/escape.cpp:9
#   error: patch failed: src/server/viewer_server.cpp:444
# The reverse (CRLF patch + LF sources) produces the same hunk errors.
# Strip CR from the patch, prefer an exact apply, then fall back to
# --ignore-whitespace / --whitespace=nowarn. Still fail loudly on a real
# content mismatch. TRACEMAKER_WINDOWS_PATCH overrides the SHA-named file
# (script tests only).
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

# Later git invocations (and a re-checkout) must not reintroduce CRLF.
git -C "$src" config core.autocrlf false
git -C "$src" config core.eol lf

commit="$(git -C "$src" rev-parse HEAD)"
if [ -n "${TRACEMAKER_WINDOWS_PATCH:-}" ]; then
  patch="$TRACEMAKER_WINDOWS_PATCH"
else
  patch="$SCRIPT_DIR/patches/${commit}-windows.patch"
fi

if [ ! -f "$patch" ]; then
  echo "No commit-pinned Windows patch for $commit."
  rm -f "$note"
  exit 0
fi

lf_patch="$(mktemp "${TMPDIR:-/tmp}/tm-winpatch.XXXXXX")"
trap 'rm -f "$lf_patch"' EXIT
# A CRLF-checked-out patch file (actions/checkout on Windows without -text)
# makes git apply treat the CR as part of every context line.
tr -d '\r' < "$patch" > "$lf_patch"

echo "Applying $patch to $src ($commit)"
apply_how="exact"
if git -C "$src" apply --check "$lf_patch"; then
  git -C "$src" apply "$lf_patch"
elif git -C "$src" apply --check --ignore-whitespace --whitespace=nowarn "$lf_patch"; then
  echo "Retrying apply with --ignore-whitespace (CRLF line endings)."
  git -C "$src" apply --ignore-whitespace --whitespace=nowarn "$lf_patch"
  apply_how="ignore-whitespace"
else
  echo "::error::patch $patch does not apply to $commit" >&2
  exit 1
fi

{
  echo "Applied fabdesk Windows patch ${patch##*/} (GPL-3.0-or-later corresponding source:"
  echo "upstream commit $commit plus this patch in TensorFleet/fabdesk"
  echo "scripts/tracemaker/patches/${commit}-windows.patch)."
  echo "MinGW UCRT64: std::numbers::pi in escape.cpp; filesystem::path::string() in viewer_server.cpp."
  echo "Apply mode: ${apply_how}."
} > "$note"
echo "Wrote $note"
