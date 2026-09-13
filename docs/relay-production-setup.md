# Setting up `relay.fabplane.com`

What has to exist for a phone on cellular to reach a fabPlane daemon through fabplane.com's
relay in production. Staging is done (`ws://fabplane-staging.tail4f6a7.ts.net:4010`, tailnet
only) and was verified end to end from an iPhone on 2026-09-13; production is **files only** —
nothing rolls it out automatically, and the steps below are the manual rollout. The relay
itself is `apps/relay` in this repo, copied into fabplane.com (`apps/relay` there, PR
[TensorFleet/fabplane.com#62](https://github.com/TensorFleet/fabplane.com/pull/62)); the
contract is in `docs/mobile-roadmap.md` §3 Phase 4 and fabplane.com's `docs/relay.md`.

## How the pieces fit

```
 phone (cellular)  ──wss://relay.fabplane.com/c/<coreId>/ws──▶  edge (TLS)  ──▶ nginx :80 ──▶ relay :4010 (loopback)
                                                                                            ▲
 daemon (home Mac) ──wss://relay.fabplane.com/d?coreId=…  (dials OUT; no inbound port) ───────┘
                    Authorization: Bearer <fabplane session>  →  relay checks GET https://api.fabplane.com/v1/auth/me
```

- The daemon picks the relay **automatically**: `FABPLANE_API_ORIGIN=https://api.fabplane.com`
  → `wss://relay.fabplane.com`. Nothing to configure on users' machines once the host exists;
  `Settings.remote.relay: "off"` opts out, `remote.relayUrl` overrides.
- The phone learns the relay from the pairing QR (`k=relay`, `s=https`, `c=<coreId>`) and uses
  it only after every direct address has failed. The device token is checked by the daemon,
  never by the relay.

## 1. Merge and sync the code

1. Merge fabdesk [#165](https://github.com/TensorFleet/fabdesk/pull/165) (relay lanes +
   device-test fixes) to `main`.
2. In fabplane.com, on the `relay/host` branch: run `scripts/sync-relay.sh <fabdesk checkout>`
   so its `apps/relay` picks up the hardened relay (limits, pings, backpressure, `/metrics`,
   graceful shutdown, auth cache), commit, and merge #62.
3. Deploy staging once more (`Deploy staging backend` workflow) so staging runs the hardened
   build; `curl http://fabplane-staging.tail4f6a7.ts.net:4010/health` should now include
   `uptimeSeconds` and `clients`.

## 2. DNS and the edge

- `relay.fabplane.com` → the production host, **proxied the same way `api.fabplane.com` is**.
- The edge must pass WebSocket upgrades (Cloudflare does by default on proxied hostnames; the
  100 s idle timeout on the free plan is fine — the relay pings every 30 s).
- TLS terminates at the edge; the origin side stays plain HTTP on port 80, like the API.

## 3. nginx on the production host

Files are in fabplane.com `deploy/production/`:

```bash
sudo cp deploy/production/nginx.relay-upgrade.conf /etc/nginx/conf.d/relay-upgrade.conf   # the http{}-level map
sudo cp deploy/production/nginx.relay.conf /etc/nginx/sites-available/relay.fabplane.com
sudo ln -s /etc/nginx/sites-available/relay.fabplane.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

What that site does: `proxy_pass http://127.0.0.1:4010`, WebSocket `Upgrade`/`Connection`
headers, `proxy_read_timeout 3600s` (daemon and phone sockets sit idle between events),
`client_max_body_size 5m` (the relay's own 4 MB / 413 wins), `/metrics` → 404 (telemetry stays
on the tailnet), `X-Forwarded-For` set.

## 4. The container

```bash
cd /opt/fabplane
RELAY_API_ORIGIN=http://api:4000 RELAY_TRUSTED_PROXIES=127.0.0.1,::1 \
  docker compose -f deploy/production/compose.relay.yaml up -d --build relay
curl -s http://127.0.0.1:4010/health          # {"ok":true,"uptimeSeconds":…,"daemons":0,"clients":0}
```

- Binds `127.0.0.1:4010` only; project name `fabplane-production` so `http://api:4000` resolves
  on the compose network (leave `RELAY_API_ORIGIN` unset to check bearers via the public API).
- Environment is only `RELAY_*` + `FABPLANE_API_ORIGIN` — the relay holds **no credentials**.
- Give it a `stop_grace_period` ≥ 1 s: on SIGTERM it closes every socket with 1012 and daemons
  reconnect on their own.

Tunables (defaults are fine to start): `RELAY_MAX_DAEMONS_PER_USER=10`,
`RELAY_MAX_CLIENTS_PER_CORE=32`, `RELAY_REQUESTS_PER_MINUTE=600`, `RELAY_PING_INTERVAL_MS=30000`,
`RELAY_IDLE_TIMEOUT_MS=90000`, `RELAY_AUTH_CACHE_TTL_MS=300000`, `RELAY_TRUSTED_PROXIES` (the
nginx peer; unset trusts nobody).

## 5. Verify from outside

```bash
curl https://relay.fabplane.com/health                    # {"ok":true,…}
curl -i https://relay.fabplane.com/c/core_nobody/health   # 503 {"error":"core offline"}
curl -i https://relay.fabplane.com/d                      # 426 (needs a WebSocket upgrade)
```

Then with a daemon signed in to production and remote access on (`fabdesk-core serve --remote`,
or the desktop's Remote access section):

```bash
curl http://127.0.0.1:47810/health | jq .relay            # "connected"
curl -s -H "authorization: Bearer $FABDESK_TOKEN" http://127.0.0.1:47810/v1/remote | jq .relay
# { "connected": true, "url": "wss://relay.fabplane.com", "since": "…" }
fabdesk-core pair                                         # prints "Reachable from anywhere via fabplane.com relay."
```

Pair a phone, turn Wi-Fi **off** (real cellular, no Tailscale), open a chat: Settings shows
**Path: Via fabplane.com relay**, `fabdesk-core devices` shows `VIA relay`. Wi-Fi back on →
`direct` within a probe cycle. Stop the daemon → the phone says "Mac is offline — the relay is
up, but it is not connected"; start it → recovers without re-pairing.

## 6. Operate

- Uptime/blackbox: `GET https://relay.fabplane.com/health` → 200 (`503 {ok:false,
shuttingDown:true}` during a drain).
- Metrics: `GET http://127.0.0.1:4010/metrics` on the host (Prometheus text):
  `relay_daemons_connected`, `relay_clients_connected`, `relay_frames_total`,
  `relay_bytes_total`, `relay_rejections_total{reason}`, `relay_auth_cache_total{result}`.
- Logs: one JSON object per line; `coreId`/`userId` appear only as 12-hex hashes.
- Restart is safe at any time: phones show "reconnecting" for a moment, daemons redial with
  backoff (1 s → 60 s cap).

## Known gaps before calling it done

- ~~`X-Forwarded-For`~~ — done: set `RELAY_TRUSTED_PROXIES=127.0.0.1,::1` on the container so
  the per-address limit keys on `CF-Connecting-IP` / the first `X-Forwarded-For` hop instead of
  nginx's loopback address. Headers from any other peer are ignored, so a direct caller cannot
  spoof its way past the limit.
- **Tailscale ACL**: staging's `tag:cursor-staging` grant lists only `tcp:4000,5173`; add
  `tcp:4010` if cloud agents need the staging relay. Production is public, so no ACL.
- **`NSAllowsArbitraryLoads`** stays in the iOS app until the tailnet path is HTTPS too; the
  production relay is TLS and needs no exception.
- **Accounts**: the daemon authenticates to the relay with the user's fabplane.com session; the
  phone never signs in. "List my machines" without a QR is a later feature (T3 gap map).
