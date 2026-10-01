import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_APPS_EXTENSION, MCP_APP_MIME, type CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let home: string;
let daemon: Daemon;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-stdio-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "test-token-0123456789abcdef";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
      }) as unknown as CoreServices,
  });
});

afterAll(async () => {
  await daemon.close("tests done");
});

/** `fabdesk-core mcp` as an MCP host would launch it, proxying to the daemon above. */
async function connect(extraArgs: string[], uiHost: boolean) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "../src/main.ts"), "mcp", "--data-dir", home, ...extraArgs],
    env: { ...(process.env as Record<string, string>), FABDESK_LOG_LEVEL: "error" },
    stderr: "ignore",
  });
  const client = new Client(
    { name: uiHost ? "apps-host" : "terminal-agent", version: "0" },
    uiHost
      ? { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } }
      : {},
  );
  await client.connect(transport);
  return client;
}

describe("stdio proxy and MCP Apps", () => {
  test("hosts that advertise MCP Apps get the views through the proxy; plain agents do not", async () => {
    const plain = await connect([], false);
    expect(plain.getServerVersion()).toMatchObject({
      name: "fabdesk",
      title: "fabPlane",
      icons: [expect.objectContaining({ mimeType: "image/svg+xml" })],
    });
    expect((await plain.listTools()).tools.map((t) => t.name)).not.toContain("board_viewer");
    await plain.close();

    const host = await connect([], true);
    const names = (await host.listTools()).tools.map((t) => t.name);
    expect(names).toContain("board_viewer");
    expect(names).toContain("shopping_list_viewer");
    const ui = await host.readResource({ uri: "ui://fabdesk/boards" });
    expect(ui.contents[0]!.mimeType).toBe(MCP_APP_MIME);
    await host.close();

    // --apps (Codex plugin) forces them for a client that says nothing.
    const forced = await connect(["--apps"], false);
    expect((await forced.listTools()).tools.map((t) => t.name)).toContain("board_viewer");
    await forced.close();

    // Replaced and closed proxy sessions are released on the daemon.
    for (let i = 0; i < 50 && daemon.mcp.activeCount() > 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(daemon.mcp.activeCount()).toBe(0);
  }, 60_000);
});
