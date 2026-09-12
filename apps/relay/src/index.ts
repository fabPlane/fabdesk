/**
 * `bun run --cwd apps/relay start`
 *
 *   RELAY_PORT            port to listen on (default 4040)
 *   RELAY_HOST            bind address (default 0.0.0.0)
 *   FABPLANE_API_ORIGIN   where daemon bearers are checked (`GET /v1/auth/me`); default
 *                         https://api.fabplane.com
 *
 * TLS is the deployment's job (a reverse proxy or the platform's edge); this process speaks plain
 * HTTP/WS. Point a daemon at it with `Settings.remote.relayUrl` and a phone reaches the daemon at
 * `<relayUrl>/c/<coreId>/…`.
 */
import { startRelay } from "./server";

const port = Number(process.env["RELAY_PORT"] ?? 4040);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`RELAY_PORT must be a port number, got ${process.env["RELAY_PORT"]}`);
  process.exit(2);
}
const relay = startRelay({
  port,
  hostname: process.env["RELAY_HOST"] ?? "0.0.0.0",
  apiOrigin: process.env["FABPLANE_API_ORIGIN"] ?? "https://api.fabplane.com",
});
console.log(
  `[relay] listening on ${relay.url} (auth: ${process.env["FABPLANE_API_ORIGIN"] ?? "https://api.fabplane.com"})`,
);

const shutdown = () => {
  relay.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
