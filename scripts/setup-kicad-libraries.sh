#!/usr/bin/env bash
# Ensure data libraries exist even on minimal self-hosted runners. No sudo/system writes.
set -euo pipefail
: "${GITHUB_ENV:?GITHUB_ENV is required}"
symbols=${KICAD_SYMBOL_DIR:-/usr/share/kicad/symbols}
footprints=${KICAD10_FOOTPRINT_DIR:-/usr/share/kicad/footprints}
if [ ! -f "$symbols/Device.kicad_sym" ] || [ ! -d "$footprints/Resistor_SMD.pretty" ]; then
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
  data=$(mktemp -d "$RUNNER_TEMP/kicad-libraries.XXXXXX")
  mkdir -p "$data/state/lists/partial" "$data/cache/archives/partial" "$data/downloads" "$data/root"
  apt_options=(
    -o "Dir::State=$data/state"
    -o "Dir::Cache=$data/cache"
    -o "Debug::NoLocking=1"
    -o "APT::Sandbox::User=$(id -un)"
  )
  apt-get "${apt_options[@]}" update -qq
  # download also repairs a runner whose package database claims missing files are installed.
  (cd "$data/downloads" && apt-get "${apt_options[@]}" download kicad-symbols kicad-footprints)
  for package in "$data/downloads/"*.deb; do
    dpkg-deb -x "$package" "$data/root"
  done
  symbols="$data/root/usr/share/kicad/symbols"
  footprints="$data/root/usr/share/kicad/footprints"
fi
test -f "$symbols/Device.kicad_sym"
test -d "$footprints/Resistor_SMD.pretty"
printf 'KICAD_SYMBOL_DIR=%s\nKICAD10_FOOTPRINT_DIR=%s\n' "$symbols" "$footprints" >> "$GITHUB_ENV"
