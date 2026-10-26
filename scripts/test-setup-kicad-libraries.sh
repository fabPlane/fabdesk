#!/usr/bin/env bash
# Exercise setup without network, root, or system library modifications.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export RUNNER_TEMP="$fixture" GITHUB_ENV="$fixture/env"
export KICAD_SYMBOL_DIR="$fixture/symbols" KICAD10_FOOTPRINT_DIR="$fixture/footprints"
mkdir -p "$KICAD_SYMBOL_DIR" "$KICAD10_FOOTPRINT_DIR/Resistor_SMD.pretty" "$fixture/bin"
touch "$KICAD_SYMBOL_DIR/Device.kicad_sym"
cat > "$fixture/bin/apt-get" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$RUNNER_TEMP/apt-calls"
if [[ " $* " == *" download "* ]]; then touch kicad-symbols.deb kicad-footprints.deb; fi
MOCK
cat > "$fixture/bin/dpkg-deb" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "${FAIL_EXTRACT:-0}" = 1 ]; then exit 1; fi
mkdir -p "$3/usr/share/kicad/symbols" "$3/usr/share/kicad/footprints/Resistor_SMD.pretty"
touch "$3/usr/share/kicad/symbols/Device.kicad_sym"
MOCK
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
bash "$repo/scripts/setup-kicad-libraries.sh"
test ! -e "$fixture/apt-calls"
grep -F "KICAD_SYMBOL_DIR=$KICAD_SYMBOL_DIR" "$GITHUB_ENV"
# Missing symbols despite existing footprints must trigger extraction of both packages.
rm "$KICAD_SYMBOL_DIR/Device.kicad_sym"
: > "$GITHUB_ENV"
bash "$repo/scripts/setup-kicad-libraries.sh"
grep -F 'download kicad-symbols kicad-footprints' "$fixture/apt-calls"
grep -E '^KICAD_SYMBOL_DIR=.*/kicad-libraries\..*/root/usr/share/kicad/symbols$' "$GITHUB_ENV"
grep -E '^KICAD10_FOOTPRINT_DIR=.*/kicad-libraries\..*/root/usr/share/kicad/footprints$' "$GITHUB_ENV"
: > "$GITHUB_ENV"
if FAIL_EXTRACT=1 bash "$repo/scripts/setup-kicad-libraries.sh"; then
  echo 'Expected extraction failure' >&2; exit 1
fi
test ! -s "$GITHUB_ENV"
echo 'KiCad library setup tests passed'
