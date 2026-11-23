#!/usr/bin/env bash
# No repository secret or authenticated GitHub API access is needed.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
report_path="${GITLEAKS_REPORT_PATH:-${RUNNER_TEMP:-/tmp}/fabdesk-gitleaks-redacted.json}"
if [ -n "${GITLEAKS_BIN:-}" ]; then
  scanner="$GITLEAKS_BIN"
else
  test "$(uname -s)" = Linux
  test "$(uname -m)" = x86_64
  install_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/fabdesk-gitleaks.XXXXXX")
  trap 'rm -rf "$install_dir"' EXIT
  curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
    https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
    -o "$install_dir/gitleaks.tar.gz"
  echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $install_dir/gitleaks.tar.gz" | sha256sum -c -
  tar -xzf "$install_dir/gitleaks.tar.gz" -C "$install_dir" gitleaks
  scanner="$install_dir/gitleaks"
fi
# Historical exceptions are exact reviewed fingerprints in .gitleaksignore.
# A fresh credential or a new occurrence still fails; do not upload raw matches.
"$scanner" git "$repo_root" --log-opts=--all --redact=100 \
  --report-format json --report-path "$report_path"
