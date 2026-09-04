#!/usr/bin/env bash
# Shared helpers for the installer test VMs (scripts/vm/{mac,linux,windows}.sh).
# Everything lives under $FABDESK_VM_DIR (default ~/.fabdesk-vm): base images, per-run clones, results.

set -euo pipefail

VM_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this directory; also works when copied to a job host
REPO_ROOT="$(cd "$VM_SCRIPTS/../.." && pwd)"
VM_DIR="${FABDESK_VM_DIR:-$HOME/.fabdesk-vm}"
RESULTS_DIR="$VM_DIR/results"
CACHE_DIR="$VM_DIR/cache"
mkdir -p "$VM_DIR" "$RESULTS_DIR" "$CACHE_DIR"

log() { printf '\033[1;32m[vm]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[vm]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[vm]\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1'. $2"; }

# Common CLI parsing. Sets: CMD, TAG, FILE, ARCH, KEEP, TIMEOUT, LATEST.
#   prepare            build/download the base image (one-time, cached)
#   test               fresh clone -> install -> launch -> screenshot -> report
#   shell              ssh/console into the last test VM (mac/linux)
#   destroy            delete base image and clones
# Installer selection for `test`: --file <installer> | --tag vX.Y.Z (GitHub release) | --latest (fabplane.com)
# Default: the newest matching file in apps/desktop/release/.
parse_args() {
  CMD="${1:-}"; shift || true
  TAG="" FILE="" ARCH="" KEEP=0 TIMEOUT="${FABDESK_VM_TIMEOUT:-900}" LATEST=0 ISO="" FORMAT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) TAG="$2"; shift 2 ;;
      --file) FILE="$2"; shift 2 ;;
      --arch) ARCH="$2"; shift 2 ;;
      --iso) ISO="$2"; shift 2 ;;
      --format) FORMAT="$2"; shift 2 ;;      # linux: appimage|deb, windows: nsis|portable, mac: dmg|zip
      --latest) LATEST=1; shift ;;
      --keep) KEEP=1; shift ;;                # leave the test VM running/around for inspection
      --timeout) TIMEOUT="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$CMD" ] || { usage; exit 1; }
}

# Picks the installer to test. Args: <os: mac|linux|win> <arch regex> <ext regex>. Prints the local path.
# electron-builder names arches inconsistently (mac-arm64/x64, linux-amd64 .deb / linux-x86_64 .AppImage,
# win-x64), so callers pass a regex such as "(x64|amd64|x86_64)".
resolve_installer() {
  local os="$1" arch="$2" ext="$3" dir out re
  if [ -n "$FILE" ]; then [ -f "$FILE" ] || die "no such file: $FILE"; echo "$FILE"; return; fi
  if [ "$LATEST" = 1 ]; then
    # The site feed lists public download URLs + sha256 per asset: no GitHub auth needed.
    need curl "install curl"
    local feed="${FABDESK_VM_FEED:-https://fabplane.com/desktop/latest.json}"
    local pick
    pick="$(curl -fsSL "$feed" | python3 -c '
import sys, json, re
os_, arch, ext = sys.argv[1:4]
d = json.load(sys.stdin)
re_ = re.compile(r"^(fabPlane|Fabdesk)-" + re.escape(d["version"]) + rf"-{os_}-{arch}.*\.({ext})$")
for a in d["assets"]:
    if re_.match(a["filename"]): print(d["tag"], a["url"], a["sha256"], a["filename"]); break
' "$os" "$arch" "$ext")"
    [ -n "$pick" ] || die "site feed has no ${os}-${arch}.(${ext}) asset"
    set -- $pick; TAG="$1"; local url="$2" sha="$3" name="$4"
    dir="$CACHE_DIR/$TAG"; mkdir -p "$dir"; out="$dir/$name"
    if [ ! -f "$out" ] || [ "$(sha256_of "$out" 2>/dev/null)" != "$sha" ]; then
      log "downloading $name from $url"; curl -fL --progress-bar -o "$out.part" "$url" && mv "$out.part" "$out"
      [ "$(sha256_of "$out")" = "$sha" ] || die "$name: sha256 mismatch against latest.json"
    fi
    log "site latest is $TAG"; echo "$out"; return
  fi
  if [ -n "$TAG" ]; then
    need gh "install GitHub CLI"
    dir="$CACHE_DIR/$TAG"; mkdir -p "$dir"
    re="^(fabPlane|Fabdesk)-${TAG#v}-${os}-${arch}.*\.(${ext})$"
    out="$(ls "$dir" 2>/dev/null | grep -E "$re" | head -1 || true)"
    if [ -z "$out" ]; then
      log "downloading fabPlane-/Fabdesk-${TAG#v}-${os}-* from release $TAG"
      gh release download "$TAG" --repo TensorFleet/fabdesk --dir "$dir" --pattern "fabPlane-${TAG#v}-${os}-*" --clobber >&2 || true
      gh release download "$TAG" --repo TensorFleet/fabdesk --dir "$dir" --pattern "Fabdesk-${TAG#v}-${os}-*" --clobber >&2 || true
      out="$(ls "$dir" | grep -E "$re" | head -1 || true)"
    fi
    [ -n "$out" ] || die "release $TAG has no file matching $re"
    echo "$dir/$out"; return
  fi
  dir="$REPO_ROOT/apps/desktop/release"
  out="$(ls -t "$dir" 2>/dev/null | grep -E "^(fabPlane|Fabdesk)-.*-${os}-${arch}.*\.(${ext})$" | head -1 || true)"
  [ -n "$out" ] || die "no fabPlane-*-${os}-${arch}.(${ext}) in $dir; pass --file, --tag vX.Y.Z or --latest"
  echo "$dir/$out"
}

# Result folder for this run.
new_result_dir() {
  local d="$RESULTS_DIR/$1-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$d"; echo "$d"
}

# Prints a one-screen summary from report.json and exits non-zero when the guest reported failure.
finish_report() {
  local dir="$1"
  [ -f "$dir/report.json" ] || die "no report.json in $dir (guest test never reported; see $dir/log.txt)"
  python3 - "$dir" <<'PY'
import json, sys, os
d = sys.argv[1]
r = json.load(open(os.path.join(d, "report.json")))
ok = r.get("ok") is True
print(("PASS" if ok else "FAIL") + f"  {r.get('platform','?')}  installer={r.get('installer','?')}")
for k in ("install", "gatekeeper", "codesign", "core_version", "health", "screenshot", "launch_ms"):
    if k in r: print(f"  {k:13} {r[k]}")
for e in r.get("errors", []): print(f"  error: {e}")
print(f"  results: {d}")
sys.exit(0 if ok else 1)
PY
}

# Free TCP port on the host.
sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d" " -f1; else shasum -a 256 "$1" | cut -d" " -f1; fi; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

# ssh/scp against a guest with password auth without sshpass (OpenSSH >= 8.4).
# Usage: guest_ssh <user> <host> <port> <password> <cmd...>
_askpass() {
  local f="$VM_DIR/.askpass-$$"
  printf '#!/bin/sh\necho "%s"\n' "$1" > "$f"; chmod 700 "$f"; echo "$f"
}
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -o PreferredAuthentications=password,publickey)
guest_ssh() {
  local user="$1" host="$2" port="$3" pass="$4"; shift 4
  local a; a="$(_askpass "$pass")"
  SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" "$@"
  local rc=$?; rm -f "$a"; return $rc
}
guest_scp() {  # guest_scp <user> <host> <port> <password> <src...> <dst>
  local user="$1" host="$2" port="$3" pass="$4"; shift 4
  local a; a="$(_askpass "$pass")"
  SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 scp "${SSH_OPTS[@]}" -P "$port" -r "$@"
  local rc=$?; rm -f "$a"; return $rc
}
wait_ssh() {  # wait_ssh <user> <host> <port> <password> <seconds>
  local i; for ((i=0; i<$5; i+=5)); do
    guest_ssh "$1" "$2" "$3" "$4" true >/dev/null 2>&1 && return 0; sleep 5
  done; return 1
}
