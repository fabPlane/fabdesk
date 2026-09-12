#!/usr/bin/env bash
# Captures the six main screens of the mobile app from an iOS simulator with `simctl`: for store
# listings, docs, and a quick visual diff after a UI change. No Maestro: the daemon from
# apps/mobile/e2e/daemon.ts is started with a fake agent, the simulator is paired over the deep
# link, a chat with one exchange is seeded through the daemon's API, and each screen is reached by
# its expo-router deep link (`fabdesk://<route>`) before `simctl io screenshot`.
#
#   scripts/mobile-screenshots.sh [--out <dir>] [--udid <id>] [--app-id <bundle id>]
#                                 [--dev-client [metro url]] [--port <n>] [--settle <seconds>]
#                                 [--fresh]
#
# Defaults: out=docs/screenshots/mobile, the first booted iPhone simulator, the bundle id from
# app.json, port 47820. The app must already be installed (apps/mobile/e2e/run.sh --build makes
# a Release one; a dev client needs --dev-client with Metro running). --fresh resets the
# simulator's keychain first so Connections shows only this run's computer (expo-secure-store
# survives an app reinstall); it wipes every app's keychain on that simulator. Screens:
#
#   01-chats  02-thread  03-projects  04-project  05-settings  06-connections
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
app_dir="$repo/apps/mobile"

out="$repo/docs/screenshots/mobile"
udid="${E2E_UDID:-}"
app_id="${APP_ID:-}"
dev_client=""
port="${E2E_PORT:-47820}"
settle=3
fresh=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --udid) udid="$2"; shift 2 ;;
    --app-id) app_id="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --settle) settle="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    --dev-client)
      if [ $# -gt 1 ] && [[ "$2" == http* ]]; then dev_client="$2"; shift 2; else dev_client="http://localhost:8081"; shift; fi ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

json() { bun -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(eval("j."+process.argv[2]))' "$@"; }
[ -n "$app_id" ] || app_id="$(json "$app_dir/app.json" expo.ios.bundleIdentifier)"
scheme="$(json "$app_dir/app.json" expo.scheme)"

if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices booted -j | bun -e '
    const d = JSON.parse(await Bun.stdin.text()).devices;
    console.log(Object.values(d).flat().find((x) => x.state === "Booted" && /iPhone/.test(x.name))?.udid ?? "")')"
  [ -n "$udid" ] || { echo "no booted iPhone simulator; boot one or pass --udid" >&2; exit 2; }
fi
xcrun simctl get_app_container "$udid" "$app_id" >/dev/null 2>&1 || { echo "$app_id is not installed on $udid" >&2; exit 2; }
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is in use; pass --port" >&2; exit 2; fi

# ---- daemon with one project, one chat, one exchange -----------------------------------------
tmp="$(mktemp -d)"
E2E_PORT="$port" E2E_HOST=127.0.0.1 E2E_PROJECT="Sensor Board" \
  E2E_REPLY="Placed U1 and the decoupling caps; DRC is clean. Want me to route the SPI bus next?" \
  bun run "$app_dir/e2e/daemon.ts" >"$tmp/daemon.log" 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
ready=""
for _ in $(seq 1 100); do
  ready="$(grep -m1 '^{"pairingUrl"' "$tmp/daemon.log" || true)"
  [ -n "$ready" ] && break
  kill -0 "$daemon_pid" 2>/dev/null || { cat "$tmp/daemon.log" >&2; exit 1; }
  sleep 0.2
done
[ -n "$ready" ] || { cat "$tmp/daemon.log" >&2; echo "daemon did not become ready" >&2; exit 1; }
field() { printf '%s' "$ready" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[process.argv[1]])' "$1"; }
pairing_url="$(field pairingUrl)"; local_url="$(field localUrl)"; token="$(field token)"

api() { curl -sf -H "authorization: Bearer $token" -H 'content-type: application/json' "$@"; }
project_id="$(api "$local_url/projects" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[0].id)')"
thread_id="$(api -X POST "$local_url/threads" -d "{\"projectId\":\"$project_id\",\"agentId\":\"claude\"}" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).id)')"
api -X POST "$local_url/threads/$thread_id/messages" -d '{"content":"Place the MCU and its decoupling caps, then run DRC."}' >/dev/null
sleep 1

# ---- drive the simulator ---------------------------------------------------------------------
mkdir -p "$out"
shot() { sleep "$settle"; xcrun simctl io "$udid" screenshot --type png "$out/$1.png" >/dev/null; echo "$out/$1.png"; }
deeplink() { xcrun simctl openurl "$udid" "$1"; }

xcrun simctl terminate "$udid" "$app_id" 2>/dev/null || true
if [ "$fresh" = 1 ]; then
  xcrun simctl keychain "$udid" reset
  xcrun simctl privacy "$udid" reset all "$app_id" 2>/dev/null || true
fi
xcrun simctl launch "$udid" "$app_id" >/dev/null
if [ -n "$dev_client" ]; then
  deeplink "$scheme://expo-development-client/?url=$dev_client"
  sleep 15
fi
sleep "$settle"
deeplink "$pairing_url"
sleep 6

deeplink "$scheme://"            ; shot 01-chats
deeplink "$scheme://thread/$thread_id" ; shot 02-thread
deeplink "$scheme://projects"    ; shot 03-projects
deeplink "$scheme://project/$project_id" ; shot 04-project
deeplink "$scheme://settings"    ; shot 05-settings
deeplink "$scheme://connect"     ; shot 06-connections
