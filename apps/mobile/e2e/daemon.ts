#!/usr/bin/env bun
/**
 * The daemon the Maestro flows run against: a real `fabdesk-core` on a scratch data dir with the
 * remote listener on loopback, a fake `claude` adapter that answers every message with a fixed
 * line (no agent binary, no network), one project so the Chats screen has a group to start a
 * chat in, and a freshly minted pairing URL. Mirrors `apps/core/test/remote.test.ts`.
 *
 * Prints one JSON line `{ pairingUrl, localUrl, remoteUrl, token }` once ready, then runs until
 * SIGINT/SIGTERM. `e2e/run.sh` drives it; run from the repo root so `apps/core`'s dependencies
 * resolve (`bun run apps/mobile/e2e/daemon.ts`).
 *
 * Env: E2E_HOST (127.0.0.1), E2E_PORT (47820), E2E_PROJECT ("E2E Board"), E2E_REPLY.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRun } from "../../../packages/agents/src";
import type { CoreServices } from "../../../packages/tools/src";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { serve } from "../../core/src/serve";

export const E2E_REPLY = process.env["E2E_REPLY"] ?? "E2E reply: the fake agent saw your message.";
const host = process.env["E2E_HOST"] ?? "127.0.0.1";
const port = Number(process.env["E2E_PORT"] ?? "47820");
const projectName = process.env["E2E_PROJECT"] ?? "E2E Board";

const home = await mkdtemp(join(tmpdir(), "fabdesk-e2e-"));
// A public-channel build only honours `localAuth` when the data dir carries the dev marker.
await writeFile(join(home, ".fabdesk-dev"), "");
process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
process.env["FABDESK_TOKEN"] ??= "e2e-token-0123456789abcdef";

const daemon = await serve({
  port: 0,
  dataDir: home,
  handshakeFile: join(home, "daemon.json"),
  localAuth: true,
  quiet: true,
  watchProjects: false,
  services: async ({ projects, bus, store }) =>
    mockServices([], {
      projects,
      bus: { emit: (e) => bus.emit(e) },
      routeRuns: store.routeRuns,
      channel: "public",
    }) as unknown as CoreServices,
  adapters: {
    claude: {
      id: "claude",
      run: (): AgentRun => ({
        events: (async function* (): AsyncGenerator<AgentEvent> {
          // Two deltas so the streaming path (not just the final message) is what gets exercised.
          yield { type: "text", delta: E2E_REPLY.slice(0, 10) };
          yield { type: "text", delta: E2E_REPLY.slice(10) };
          yield { type: "done", exitCode: 0 };
        })(),
        abort() {},
      }),
    },
  },
  doctor: async () => ({
    version: "e2e",
    channel: "public",
    bun: Bun.version,
    platform: process.platform,
    kicad: { found: false },
    ngspice: { found: false },
    routers: [],
    agents: [],
    warnings: [],
  }),
});

const headers = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
const local = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${daemon.url}${path}`, { ...init, headers });
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

await local("/settings", {
  method: "PATCH",
  body: JSON.stringify({ remote: { enabled: true, host, port } }),
});
await local("/projects", { method: "POST", body: JSON.stringify({ name: projectName }) });
const start = (await local("/v1/devices/pair/start", { method: "POST" })) as { url: string };

console.log(
  JSON.stringify({
    pairingUrl: start.url,
    localUrl: daemon.url,
    remoteUrl: `http://${host}:${port}`,
    token: daemon.token,
    home,
  }),
);

const stop = () => {
  void daemon.close("e2e done").then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await daemon.closed;
