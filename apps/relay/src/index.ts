/**
 * `bun run --cwd apps/relay start`
 *
 *   RELAY_PORT                  port to listen on (default 4040)
 *   RELAY_HOST                  bind address (default 0.0.0.0)
 *   FABPLANE_API_ORIGIN         where daemon bearers are checked (`GET /v1/auth/me`); default
 *                               https://api.fabplane.com
 *   RELAY_AUTH_CACHE_TTL_MS     how long an auth verdict is reused (default 300000; 0 disables)
 *   RELAY_MAX_DAEMONS_PER_USER  distinct cores one account may keep connected (default 10)
 *   RELAY_MAX_CLIENTS_PER_CORE  phone WebSockets per core (default 32)
 *   RELAY_REQUESTS_PER_MINUTE   proxied HTTP requests per minute per account (default 600)
 *   RELAY_PING_INTERVAL_MS      ping a quiet socket after this long (default 30000)
 *   RELAY_IDLE_TIMEOUT_MS       close a silent socket after this long (default 90000)
 *   RELAY_SHUTDOWN_GRACE_MS     wait for close frames on SIGTERM before exit (default 500)
 *
 * TLS is the deployment's job (a reverse proxy or the platform's edge); this process speaks plain
 * HTTP/WS. Point a daemon at it with `Settings.remote.relayUrl` and a phone reaches the daemon at
 * `<relayUrl>/c/<coreId>/…`. `/health` and `/metrics` are unauthenticated and identifier-free.
 *
 * On SIGTERM/SIGINT the relay stops accepting peers (`/health` → 503), answers in-flight requests
 * with 503, closes phones and daemons with 1012 (both reconnect), then exits.
 */
import { startRelay } from "./server";

const env = process.env;
const intEnv = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${name} must be an integer in [${min}, ${max}], got ${raw}`);
    process.exit(2);
  }
  return n;
};

const port = intEnv("RELAY_PORT", 4040, 0, 65535);
const apiOrigin = env["FABPLANE_API_ORIGIN"] ?? "https://api.fabplane.com";
const relay = startRelay({
  port,
  hostname: env["RELAY_HOST"] ?? "0.0.0.0",
  apiOrigin,
  authCacheTtlMs: intEnv("RELAY_AUTH_CACHE_TTL_MS", 5 * 60_000),
  limits: {
    maxDaemonsPerUser: intEnv("RELAY_MAX_DAEMONS_PER_USER", 10, 1),
    maxClientsPerCore: intEnv("RELAY_MAX_CLIENTS_PER_CORE", 32, 1),
    requestsPerMinutePerUser: intEnv("RELAY_REQUESTS_PER_MINUTE", 600, 1),
  },
  idle: {
    pingIntervalMs: intEnv("RELAY_PING_INTERVAL_MS", 30_000, 1000),
    idleTimeoutMs: intEnv("RELAY_IDLE_TIMEOUT_MS", 90_000, 2000),
  },
});
console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    msg: "relay up",
    url: relay.url,
    apiOrigin,
  }),
);

let exiting = false;
const shutdown = (signal: string) => {
  if (exiting) return;
  exiting = true;
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "signal", signal }),
  );
  void relay
    .shutdown({ graceMs: intEnv("RELAY_SHUTDOWN_GRACE_MS", 500) })
    .then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
