#!/usr/bin/env bash
# Runs the Maestro flows in this directory against a booted iOS simulator and a daemon started
# with a fake agent (e2e/daemon.ts): no real `claude`, no network beyond loopback.
#
#   apps/mobile/e2e/run.sh [options] [flow.yaml ...]
#
#   --udid <id>          simulator to use (default: the first booted iPhone, else boot one)
#   --port <n>           remote listener port for the daemon (default 47820; must be free)
#   --dev-client [url]   the installed build is a dev client: hand it Metro (default
#                        http://localhost:8081, which must already be running — `bun run mobile`)
#   --build              build and install a Release simulator app first (`expo run:ios`);
#                        what CI does, ~15 min cold
#   --app-id <id>        bundle id to drive (default: ios.bundleIdentifier from app.json)
#
# Needs: maestro on PATH (curl -Ls https://get.maestro.mobile.dev | bash → ~/.maestro/bin),
# Xcode with a simulator runtime, bun. Exit code is maestro's; the daemon is stopped either way.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$here/.." && pwd)"
export PATH="$HOME/.maestro/bin:$PATH"

udid="${E2E_UDID:-}"
port="${E2E_PORT:-47820}"
dev_client=""
build=0
app_id="${APP_ID:-}"
flows=()
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) udid="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --dev-client)
      if [ $# -gt 1 ] && [[ "$2" == http* ]]; then dev_client="$2"; shift 2; else dev_client="http://localhost:8081"; shift; fi ;;
    --build) build=1; shift ;;
    --app-id) app_id="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) flows+=("$1"); shift ;;
  esac
done
[ ${#flows[@]} -gt 0 ] || flows=("$here/pair-and-chat.yaml")

command -v maestro >/dev/null || { echo "maestro not found; curl -Ls https://get.maestro.mobile.dev | bash" >&2; exit 2; }

app_json="$app_dir/app.json"
[ -n "$app_id" ] || app_id="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).expo.ios.bundleIdentifier)' "$app_json")"
app_scheme="$(bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).expo.scheme)' "$app_json")"

# ---- simulator -------------------------------------------------------------------------------
if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices booted -j | bun -e '
    const d = JSON.parse(await Bun.stdin.text()).devices;
    const all = Object.values(d).flat().filter((x) => x.state === "Booted" && /iPhone/.test(x.name));
    console.log(all[0]?.udid ?? "")')"
fi
if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices available -j | bun -e '
    const d = JSON.parse(await Bun.stdin.text()).devices;
    const all = Object.entries(d).filter(([rt]) => /iOS/.test(rt)).flatMap(([, v]) => v).filter((x) => /iPhone/.test(x.name));
    console.log(all.at(-1)?.udid ?? "")')"
  [ -n "$udid" ] || { echo "no iPhone simulator available" >&2; exit 2; }
  echo "booting simulator $udid"
  xcrun simctl boot "$udid" || true
fi
xcrun simctl bootstatus "$udid" -b >/dev/null
echo "simulator: $udid"

if [ "$build" = 1 ]; then
  # Release configuration embeds the JS bundle, so the run needs no Metro. `expo run:ios` also
  # installs and launches; the flow's launchApp restarts it with clean state.
  (cd "$app_dir" && bunx expo run:ios --configuration Release --device "$udid" --no-bundler)
fi
xcrun simctl get_app_container "$udid" "$app_id" >/dev/null 2>&1 || {
  echo "$app_id is not installed on $udid (use --build, or install a dev client and pass --dev-client)" >&2
  exit 2
}

# ---- daemon ----------------------------------------------------------------------------------
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port is in use; pass --port <free port>" >&2
  exit 2
fi
out="$(mktemp -d)"
reply_text="${E2E_REPLY:-E2E reply: the fake agent saw your message.}"
project_name="${E2E_PROJECT:-E2E Board}"
E2E_PORT="$port" E2E_HOST=127.0.0.1 E2E_REPLY="$reply_text" E2E_PROJECT="$project_name" \
  bun run "$here/daemon.ts" >"$out/daemon.log" 2>&1 &
daemon_pid=$!
cleanup() {
  kill "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 100); do
  ready="$(grep -m1 '^{"pairingUrl"' "$out/daemon.log" || true)"
  [ -n "$ready" ] && break
  kill -0 "$daemon_pid" 2>/dev/null || { cat "$out/daemon.log" >&2; echo "daemon exited" >&2; exit 1; }
  sleep 0.2
done
[ -n "$ready" ] || { cat "$out/daemon.log" >&2; echo "daemon did not become ready" >&2; exit 1; }
pairing_url="$(printf '%s' "$ready" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).pairingUrl)')"
echo "daemon ready on 127.0.0.1:$port"

# ---- maestro ---------------------------------------------------------------------------------
status=0
maestro --udid "$udid" test \
  -e APP_ID="$app_id" \
  -e APP_SCHEME="$app_scheme" \
  -e PAIRING_URL="$pairing_url" \
  -e REPLY_TEXT="$reply_text" \
  -e PROJECT_NAME="$project_name" \
  -e DEV_CLIENT_URL="$dev_client" \
  "${flows[@]}" || status=$?
if [ "$status" != 0 ]; then
  echo "--- daemon log ---" >&2
  cat "$out/daemon.log" >&2
fi
exit "$status"
