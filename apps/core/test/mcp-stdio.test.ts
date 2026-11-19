import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_APPS_EXTENSION, MCP_APP_MIME, type CoreServices } from "@fabdesk/tools";
import { BOARD_WORKFLOW_MD } from "@fabdesk/agents";
import { BOARD_WORKFLOW_PROMPT, BOARD_WORKFLOW_RESOURCE_URI } from "../src/mcp-sessions";
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
async function connect(extraArgs: string[], uiHost: boolean, name?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "../src/main.ts"), "mcp", "--data-dir", home, ...extraArgs],
    env: { ...(process.env as Record<string, string>), FABDESK_LOG_LEVEL: "error" },
    stderr: "ignore",
  });
  const client = new Client(
    { name: name ?? (uiHost ? "apps-host" : "terminal-agent"), version: "0" },
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

describe("stdio proxy: a board project for an external agent", () => {
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    });
  const project = async (name: string, pcb: string | null) => {
    const created = (await (await api("/projects", { method: "POST", body: JSON.stringify({ name }) })).json()) as { path: string };
    // a project folder as the desktop writes it (the proxy names it by path, which needs the KiCad project files)
    await writeFile(join(created.path, "board.kicad_pro"), "{}\n");
    await writeFile(join(created.path, "board.kicad_sch"), "(kicad_sch (version 20231120))\n");
    await writeFile(join(created.path, "board.kicad_pcb"), pcb ?? "(kicad_pcb (version 20240108))\n");
    return created.path;
  };

  test("a placed board starts with the board tools, the workflow pointer, resource and prompt; no board keeps the defaults", async () => {
    const placed = await project("Placed Board", '(kicad_pcb (version 20240108)\n  (footprint "Resistor_SMD:R_0402"\n  )\n)\n');
    const board = await connect(["--project", placed], false, "codex-mcp-client");
    const names = (await board.listTools()).tools.map((t) => t.name);
    for (const n of ["board_check", "board_route", "board_edit", "board_review", "board_silk", "board_release", "board_job", "pcb_inspect", "render_view"])
      expect(names).toContain(n);
    // the desktop's board start set: board_check supersedes verify_drc, no schematic authoring
    for (const n of ["verify_drc", "schematic_edit", "pcb_update_from_schematic"]) expect(names).not.toContain(n);
    const instructions = board.getInstructions() ?? "";
    expect(instructions).toContain("Board workflow");
    expect(instructions).toContain("A1-A9");
    expect(instructions).toContain("listed from the start");
    expect(instructions).toContain(BOARD_WORKFLOW_RESOURCE_URI);
    const doc = await board.readResource({ uri: BOARD_WORKFLOW_RESOURCE_URI });
    expect((doc.contents[0] as { text: string }).text).toBe(BOARD_WORKFLOW_MD);
    const prompt = await board.getPrompt({ name: BOARD_WORKFLOW_PROMPT, arguments: { project: "Placed Board" } });
    expect((prompt.messages[0]!.content as { text: string }).text.endsWith(BOARD_WORKFLOW_MD)).toBe(true);
    // tool calls still carry the proxy's project, alongside the host hint in _meta
    const status = await board.callTool({ name: "project_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    await board.close();

    const empty = await project("No Board Yet", null);
    const plain = await connect(["--project", empty], false);
    const plainNames = (await plain.listTools()).tools.map((t) => t.name);
    expect(plainNames).toContain("circuit_build");
    expect(plainNames).toContain("verify_drc");
    expect(plainNames).not.toContain("board_check");
    // the pointer is there too, naming how to reach the board toolset
    expect(plain.getInstructions() ?? "").toContain('load_toolset {"toolset":"board"}');
    await plain.close();
    for (let i = 0; i < 50 && daemon.mcp.activeCount() > 0; i++) await new Promise((r) => setTimeout(r, 100));
  }, 60_000);
});
