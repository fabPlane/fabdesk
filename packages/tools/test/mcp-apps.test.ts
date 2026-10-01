import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CloudService,
  MCP_APPS_EXTENSION,
  MCP_APP_MIME,
  MCP_APP_TOOLS,
  UI_RESOURCES,
  attachToRegistry,
  createRegistry,
  mentionItems,
  type CadService,
  type McpAppsMode,
} from "../src";
import { fakeCloud } from "./fake-cloud";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const LINE_DXF = [
  "0",
  "SECTION",
  "2",
  "ENTITIES",
  "0",
  "LINE",
  "8",
  "Edge.Cuts",
  "10",
  "0",
  "20",
  "0",
  "11",
  "25",
  "21",
  "10",
  "0",
  "ENDSEC",
  "0",
  "EOF",
].join("\n");

/** Just the CadService calls the views make: export (STL bytes) and the live web UI URL. */
const fakeCad = (): CadService =>
  ({
    export: async (_dir: string, input: { format: string }) => ({
      data: new TextEncoder().encode(`solid ${input.format}\nendsolid\n`),
      fileName: "Model.stl",
      objects: ["Enclosure"],
    }),
    view: async () => ({
      bridgeUrl: "http://127.0.0.1:4030",
      session: "s1",
      wsUrl: "ws://127.0.0.1:4030/ws?session=s1",
      uiUrl: "http://127.0.0.1:4030/?ws=s1",
      document: "Model",
    }),
  }) as unknown as CadService;

async function pair(
  opts: { apps?: McpAppsMode; uiClient?: boolean; toolsOnly?: boolean; cad?: boolean } = {},
) {
  const project = await tempProject("apps");
  await mkdir(join(project.dir, "exports", "dxf"), { recursive: true });
  await writeFile(join(project.dir, "exports", "dxf", "board-Edge_Cuts.dxf"), LINE_DXF);
  await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
  await mkdir(join(project.dir, "renders"), { recursive: true });
  // Written after the board, so the viewer serves it without re-rendering.
  await writeFile(join(project.dir, "renders", "pcb.svg"), "<svg/>");
  const api = fakeCloud();
  const cloud = new CloudService({
    apiOrigin: "https://api.fabplane.com",
    token: () => "fpd_test",
    orgSetting: () => null,
    api: api.factory,
  });
  if (opts.cad) await writeFile(join(project.dir, "model.FCStd"), "PK");
  const services = mockServices([project], { cloud, ...(opts.cad ? { cad: fakeCad() } : {}) });
  const server = new McpServer({ name: "fabdesk-test", version: "0.0.0" });
  attachToRegistry(server, createRegistry(), contextFactory(services, project), {
    ...(opts.apps ? { apps: opts.apps } : {}),
    ...(opts.toolsOnly ? { toolsOnly: true } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client(
    { name: "apps-host", version: "0.0.0" },
    opts.uiClient === false
      ? {}
      : { capabilities: { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME] } } } },
  );
  await client.connect(clientT);
  return { client, project, api };
}

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

async function ui(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
) {
  const res = (await client.callTool({
    name: "fabdesk_ui_call",
    arguments: { name, arguments: args },
    ...(meta ? { _meta: meta } : {}),
  })) as CallToolResult;
  return res;
}

describe("MCP Apps views", () => {
  test("auto mode lists the app tools only for clients that advertise MCP Apps", async () => {
    const plain = await pair({ uiClient: false });
    expect(await names(plain.client)).not.toContain("board_viewer");
    const host = await pair();
    const listed = await names(host.client);
    for (const name of MCP_APP_TOOLS) expect(listed).toContain(name);
    // Forced on for a client that says nothing (Codex plugin via --apps); off and toolsOnly register nothing.
    expect(await names((await pair({ apps: "on", uiClient: false })).client)).toContain(
      "board_viewer",
    );
    expect(await names((await pair({ apps: "off" })).client)).not.toContain("board_viewer");
    expect(await names((await pair({ toolsOnly: true })).client)).not.toContain("board_viewer");
  });

  test("tools carry MCP Apps and OpenAI entrypoint metadata", async () => {
    const { client } = await pair();
    const tools = (await client.listTools()).tools;
    const board = tools.find((t) => t.name === "board_viewer")!;
    expect(board._meta).toMatchObject({
      ui: { resourceUri: UI_RESOURCES.boards },
      "openai/ui": {
        entrypoints: [
          { type: "global" },
          { type: "thread" },
          {
            type: "file",
            extensions: expect.arrayContaining([".kicad_pcb", ".dxf", ".stl", ".glb"]),
          },
        ],
      },
    });
    // Entrypoints open with {}: nothing may be required.
    expect(board.inputSchema.required ?? []).toEqual([]);
    const shopping = tools.find((t) => t.name === "shopping_list_viewer")!;
    expect(shopping._meta).toMatchObject({ ui: { resourceUri: UI_RESOURCES.shopping } });
    expect(tools.find((t) => t.name === "fabdesk_ui_call")!._meta).toEqual({
      ui: { visibility: ["app"] },
    });
    expect(tools.find((t) => t.name === "search_mentions")!._meta).toEqual({
      "openai/extensions": { "mentions/search": {} },
      ui: { visibility: ["app"] },
    });
  });

  test("ui:// resources are MCP App HTML with the bridge and a CSP for the 3D CDN only", async () => {
    const { client } = await pair();
    const boards = await client.readResource({ uri: UI_RESOURCES.boards });
    const item = boards.contents[0]!;
    expect(item.mimeType).toBe(MCP_APP_MIME);
    expect(item.text as string).toStartWith("<!doctype html>");
    expect(item.text as string).toContain("ui/initialize");
    expect(item.text as string).toContain("fabdesk_ui_call");
    expect(item._meta).toMatchObject({
      ui: { csp: { resourceDomains: ["https://cdn.jsdelivr.net"] } },
    });
    const shopping = await client.readResource({ uri: UI_RESOURCES.shopping });
    expect(shopping.contents[0]!.text as string).toContain("shopping_list_update");
    expect(shopping.contents[0]!._meta).not.toHaveProperty("ui.csp");
  });

  test("board_viewer returns projects with CAD files and a text fallback", async () => {
    const { client, project } = await pair();
    const res = (await client.callTool({ name: "board_viewer", arguments: {} })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      projects: Array<{ id: string; cadFiles: string[] }>;
      project: string;
    };
    expect(sc.project).toBe(project.id);
    expect(sc.projects[0]!.cadFiles).toEqual(["exports/dxf/board-Edge_Cuts.dxf"]);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain(
      'Opened the fabPlane Boards viewer on "apps"',
    );

    const file = (await client.callTool({
      name: "board_viewer",
      arguments: { file: { name: "part.stl", resourceUri: "host-resource://1" } },
    })) as CallToolResult;
    expect(file.structuredContent).toEqual({ file: { name: "part.stl" } });
  });

  test("previews: cached PCB SVG, DXF drawings as SVG, jailed paths", async () => {
    const { client, project } = await pair();
    const pcb = await ui(client, "preview", { project: project.id, view: "pcb" });
    expect(pcb.isError).toBeFalsy();
    expect(pcb.structuredContent).toMatchObject({
      kind: "svg",
      sheets: [{ name: "PCB", svg: "<svg/>" }],
    });
    const fresh = await ui(client, "preview", { project: project.id, view: "pcb", refresh: true });
    expect(fresh.structuredContent).toMatchObject({
      sheets: [{ svg: expect.stringContaining("<text>pcb</text>") }],
    });

    const drawing = await ui(client, "preview", {
      project: project.id,
      view: "drawing",
      path: "exports/dxf/board-Edge_Cuts.dxf",
    });
    const sc = drawing.structuredContent as {
      kind: string;
      sheets: Array<{ svg: string }>;
      title: string;
    };
    expect(sc.kind).toBe("svg");
    expect(sc.sheets[0]!.svg).toContain('x2="25" y2="10"');
    expect(sc.title).toContain("1 entities");

    const escape = await ui(client, "preview", {
      project: project.id,
      view: "drawing",
      path: "../../etc/passwd.dxf",
    });
    expect(escape.isError).toBe(true);
    const notCad = await ui(client, "preview", {
      project: project.id,
      view: "drawing",
      path: "fabdesk.json",
    });
    expect(notCad.isError).toBe(true);
  });

  test("host_file reads the host-provided path; the dispatcher only runs allowlisted tools", async () => {
    const { client, project } = await pair();
    const path = join(project.dir, "exports", "dxf", "board-Edge_Cuts.dxf");
    const ok = await ui(client, "host_file", {}, { "openai/resource": { path } });
    expect(ok.structuredContent).toMatchObject({
      kind: "svg",
      title: expect.stringContaining("board-Edge_Cuts.dxf"),
    });
    const missing = await ui(client, "host_file");
    expect(missing.isError).toBe(true);
    const wrongType = await ui(
      client,
      "host_file",
      {},
      { "openai/resource": { path: join(project.dir, "fabdesk.json") } },
    );
    expect(wrongType.isError).toBe(true);

    const converted = await ui(client, "convert", { name: "x.dxf", text: LINE_DXF });
    expect(converted.structuredContent).toMatchObject({ kind: "svg" });

    const denied = await ui(client, "project_write_file", { path: "x", content: "y" });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0]!.text).toContain(
      "not available to views",
    );
  });

  test("FreeCAD model: flagged in summaries, exported as STL for the drawings tab, live UI URL", async () => {
    const { client, project } = await pair({ cad: true });
    const viewer = (await client.callTool({
      name: "board_viewer",
      arguments: {},
    })) as CallToolResult;
    expect(viewer.structuredContent).toMatchObject({ projects: [{ hasCadModel: true }] });
    expect((viewer.content as Array<{ text: string }>)[0]!.text).toContain("FreeCAD model");

    const exported = await ui(client, "cad_export", {
      project: project.id,
      format: "stl",
      name: "model",
    });
    expect(exported.structuredContent).toMatchObject({ path: "exports/model.stl", format: "stl" });
    const projects = await ui(client, "projects");
    expect(
      (projects.structuredContent as { projects: Array<{ cadFiles: string[] }> }).projects[0]!
        .cadFiles,
    ).toContain("exports/model.stl");
    const mesh = await ui(client, "preview", {
      project: project.id,
      view: "drawing",
      path: "exports/model.stl",
    });
    expect(mesh.structuredContent).toMatchObject({ kind: "mesh", format: "stl" });

    const view = await ui(client, "cad_view", { project: project.id });
    expect(view.structuredContent).toMatchObject({ uiUrl: "http://127.0.0.1:4030/?ws=s1" });

    // Without a FreeCAD bridge the flag is false and cad_* calls fail with a clear error.
    const plain = await pair();
    const none = await ui(plain.client, "cad_view", { project: plain.project.id });
    expect(none.isError).toBe(true);
  });

  test("shopping list viewer and edits go through the shopping tools", async () => {
    const { client, project } = await pair();
    const empty = (await client.callTool({
      name: "shopping_list_viewer",
      arguments: {},
    })) as CallToolResult;
    expect(empty.structuredContent).toMatchObject({ project: project.id, list: { cart: null } });

    const added = await ui(client, "shopping_list_add", {
      project: project.id,
      items: [{ quantity: 2, description: "M3 standoff" }],
    });
    expect(added.isError).toBeFalsy();
    const list = await ui(client, "shopping_list_get", { project: project.id });
    const items = (
      list.structuredContent as { cart: { items: Array<{ id: string; quantity: number }> } }
    ).cart.items;
    expect(items.map((i) => i.quantity)).toEqual([2]);

    const updated = await ui(client, "shopping_list_update", {
      project: project.id,
      itemId: items[0]!.id,
      status: "ordered",
    });
    expect(updated.structuredContent).toMatchObject({ item: { status: "ordered" } });

    const viewer = (await client.callTool({
      name: "shopping_list_viewer",
      arguments: {},
    })) as CallToolResult;
    expect((viewer.content as Array<{ text: string }>)[0]!.text).toContain("M3 standoff");

    const resource = await client.readResource({
      uri: `fabdesk://project/${project.id}/shopping-list`,
    });
    expect(JSON.parse(resource.contents[0]!.text as string).cart.items).toHaveLength(1);
  });

  test("mentions search projects, shopping lists and CAD files; CAD files are readable resources", async () => {
    const { client, project } = await pair();
    const res = (await client.callTool({
      name: "search_mentions",
      arguments: { query: "edge" },
    })) as CallToolResult;
    const items = (res.structuredContent as { items: Array<{ uri: string; type: string }> }).items;
    expect(items).toEqual([
      expect.objectContaining({
        type: "resource_link",
        uri: `fabdesk://project/${project.id}/files/${encodeURIComponent("exports/dxf/board-Edge_Cuts.dxf")}`,
      }),
    ]);
    const read = await client.readResource({ uri: items[0]!.uri });
    expect(read.contents[0]!.text).toBe(LINE_DXF);

    const all = (await client.callTool({
      name: "search_mentions",
      arguments: { query: "" },
    })) as CallToolResult;
    expect((all.structuredContent as { items: unknown[] }).items).toHaveLength(3);
    expect(mentionItems([], "x")).toEqual([]);
  });
});
