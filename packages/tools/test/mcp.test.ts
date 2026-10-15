import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { attachToRegistry, createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function pair(
  initialTools?: string[],
  capabilityExclude?: string[],
  channel?: "public" | "internal",
) {
  const registry = createRegistry(channel ? { channel } : {});
  const project = await tempProject("mcp");
  const services = mockServices([project]);
  const server = new McpServer({ name: "fabdesk-test", version: "0.0.0" });
  const attachment = attachToRegistry(server, registry, contextFactory(services, project), {
    ...(initialTools ? { initialTools } : {}),
    ...(capabilityExclude ? { capabilityExclude } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return { client, server, attachment, project, services, registry };
}

describe("mcp adapter", () => {
  test("all exposed and discovered tools carry explicit effect annotations", async () => {
    const registry = createRegistry();
    const { client, server } = await pair(registry.list().map((tool) => tool.name));
    try {
      const tools = (await client.listTools()).tools;
      expect(tools).toHaveLength(registry.list().length + 2);
      for (const tool of tools) {
        for (const key of [
          "readOnlyHint",
          "destructiveHint",
          "openWorldHint",
          "idempotentHint",
        ] as const)
          expect(typeof tool.annotations?.[key]).toBe("boolean");
        const definition = registry.get(tool.name);
        if (definition)
          expect(tool.annotations).toEqual({ title: definition.title, ...definition.annotations });
        if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
      }
    } finally {
      await client.close();
      await server.close();
    }

    const native = await pair(["project_status"]);
    try {
      for (const name of ["sim_run", "inventory_search", "app_wait_for"]) {
        const search = await native.client.callTool({
          name: "capability_search",
          arguments: { query: name },
        });
        const matches = (
          search.structuredContent as { matches: Array<{ name: string; annotations: unknown }> }
        ).matches;
        expect(matches.find((match) => match.name === name)?.annotations).toEqual(
          registry.get(name)!.annotations,
        );
      }
    } finally {
      await native.client.close();
      await native.server.close();
    }
  });

  test("native profile is small and searches/calls the hidden catalog", async () => {
    const { client } = await pair(["project_status", "pcb_inspect"]);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "capability_call",
      "capability_search",
      "pcb_inspect",
      "project_status",
    ]);
    const undiscovered = await client.callTool({
      name: "capability_call",
      arguments: {
        name: "circuit_describe_part",
        arguments: { kind: "symbol", libId: "Device:R" },
      },
    });
    expect(undiscovered.isError).toBe(true);
    const search = await client.callTool({
      name: "capability_search",
      arguments: { query: "describe part pins" },
    });
    const matches = (search.structuredContent as { matches: Array<{ name: string }> }).matches;
    expect(matches.some((match) => match.name === "circuit_describe_part")).toBe(true);
    const called = await client.callTool({
      name: "capability_call",
      arguments: {
        name: "circuit_describe_part",
        arguments: { kind: "symbol", libId: "Device:R" },
      },
    });
    expect(called.isError).toBeFalsy();
    expect((called.content as Array<{ text?: string }>)[0]?.text).toContain("symbol Device:R");
  });

  test("native capability search hides legacy netlist compiler operations", async () => {
    const { client } = await pair(
      ["project_status", "pcb_inspect"],
      ["circuit_build", "circuit_read_errors", "load_toolset"],
    );
    const search = await client.callTool({
      name: "capability_search",
      arguments: { query: "netlist libSource build errors", limit: 20 },
    });
    const names = (search.structuredContent as { matches: Array<{ name: string }> }).matches.map(
      (match) => match.name,
    );
    expect(names).not.toContain("circuit_build");
    expect(names).not.toContain("circuit_read_errors");
    expect(names).not.toContain("load_toolset");
  });

  test("route_run offers both routers on every channel", async () => {
    const routerEnum = async (channel: "public" | "internal") => {
      const { client, server } = await pair(undefined, undefined, channel);
      try {
        const tool = (await client.listTools()).tools.find((t) => t.name === "route_run")!;
        const router = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> })
          .properties["router"]!;
        const rejected = await client.callTool({
          name: "route_run",
          arguments: { router: "freerouting", waitMs: 0 },
        });
        return { values: router.enum, rejected };
      } finally {
        await client.close();
        await server.close();
      }
    };
    const packaged = await routerEnum("public");
    expect(packaged.values).toEqual(["fab_router", "freerouting", "capacity", "tracemaker"]);
    expect((packaged.rejected.content as Array<{ text: string }>)[0]!.text).toContain("board.kicad_pcb");
    const internal = await routerEnum("internal");
    expect(internal.values).toEqual(packaged.values);
  });

  test("load_toolset accepts a toolset alias and reports the canonical id", async () => {
    const { client, attachment } = await pair();
    const res = await client.callTool({ name: "load_toolset", arguments: { toolset: "routing" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { toolset: string }).toolset).toBe("route");
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('Toolset "route" enabled');
    expect(attachment.session.enabledToolsets()).toEqual(["core", "route"]);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("route_status");
    const unknown = await client.callTool({
      name: "load_toolset",
      arguments: { toolset: "routes" },
    });
    expect(unknown.isError).toBe(true);
    expect(attachment.session.enabledToolsets()).toEqual(["core", "route"]);
  });

  test("core tools visible, load_toolset enables more and emits list_changed", async () => {
    const { client, attachment } = await pair();
    const initial = await client.listTools();
    const names = initial.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "capability_call",
      "capability_search",
      "circuit_build",
      "circuit_place",
      "circuit_read_errors",
      "load_toolset",
      "pcb_environment",
      "project_status",
      "render_board",
      "route_run",
      "verify_drc",
    ]);
    const t = initial.tools.find((x) => x.name === "circuit_build")!;
    expect(
      (t.inputSchema as { properties: Record<string, unknown> }).properties["project"],
    ).toBeDefined();
    expect(t.annotations?.idempotentHint).toBe(false);

    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    const res = await client.callTool({ name: "load_toolset", arguments: { toolset: "export" } });
    expect(res.isError).toBeFalsy();
    const after = await client.listTools();
    expect(after.tools.map((t) => t.name)).toContain("export_gerbers");
    expect(after.tools.length).toBe(11 + 7);
    expect(attachment.session.enabledToolsets()).toEqual(["core", "export"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(listChanged).toBeGreaterThan(0);
  });

  test("project_status, build with progress, structured content and errors", async () => {
    const { client } = await pair();
    const status = await client.callTool({ name: "project_status", arguments: {} });
    const text = (status.content as Array<{ type: string; text?: string }>)[0]!.text!;
    expect(text).toContain('Project "mcp"');
    expect(status.structuredContent).toMatchObject({
      contract: { name: "fabdesk.project-status", version: "2.0.0" },
      name: "mcp",
      lastSourceBuild: null,
      lastRelease: { status: "never" },
    });
    expect((status.structuredContent as Record<string, unknown>)["lastBuild"]).toBeUndefined();

    const progress: number[] = [];
    const build = await client.callTool({ name: "circuit_build", arguments: {} }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    });
    expect(build.isError).toBeFalsy();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(100);

    // Durable routing with waitMs 0 returns immediately; it needs no request heartbeats to survive
    // a client idle timeout.
    process.env["FABDESK_MCP_HEARTBEAT_MS"] = "2";
    try {
      const beats: number[] = [];
      await client.callTool(
        { name: "route_run", arguments: { timeoutMs: 1000, waitMs: 0 } },
        undefined,
        {
          onprogress: (p) => beats.push(p.progress),
        },
      );
      expect(beats.length).toBeLessThanOrEqual(1);
    } finally {
      delete process.env["FABDESK_MCP_HEARTBEAT_MS"];
    }

    const bad = await client.callTool({
      name: "circuit_read_errors",
      arguments: { project: "does-not-exist" },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]!.text).toContain("no project selected");
  });

  test("svg render returns an embedded resource; resources and the shopping_list prompt are listed", async () => {
    const { client, project } = await pair();
    await client.callTool({ name: "circuit_build", arguments: {} });
    await client.callTool({ name: "load_toolset", arguments: { toolset: "render" } });
    const svg = await client.callTool({ name: "render_pcb_svg", arguments: {} });
    const blocks = svg.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "resource"]);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "fabdesk://project/{id}/board-summary",
      "fabdesk://project/{id}/files/{path}",
      "fabdesk://project/{id}/manifest",
      "fabdesk://project/{id}/reports/{name}",
      "fabdesk://project/{id}/shopping-list",
    ]);
    const list = await client.listResources();
    expect(list.resources.some((r) => r.uri === `fabdesk://project/${project.id}/manifest`)).toBe(
      true,
    );
    const manifest = await client.readResource({ uri: `fabdesk://project/${project.id}/manifest` });
    expect(JSON.parse(manifest.contents[0]!.text as string).name).toBe("mcp");
    const summary = await client.readResource({
      uri: `fabdesk://project/${project.id}/board-summary`,
    });
    expect(JSON.parse(summary.contents[0]!.text as string).built).toBe(true);
    const report = await client.readResource({
      uri: `fabdesk://project/${project.id}/reports/build`,
    });
    expect(JSON.parse(report.contents[0]!.text as string).ok).toBe(true);

    // The only prompt is `shopping_list` (`/mcp__fabdesk__shopping_list` in Claude Code).
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(["shopping_list"]);
    const prompt = await client.getPrompt({
      name: "shopping_list",
      arguments: { request: "add 10 spare LEDs" },
    });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain("shopping_list_add");
    expect(text).toContain("Request: add 10 spare LEDs");
  });
});

test("direct MCP rejects Qwen placement coordinates before mutation", async () => {
  const { client, server } = await pair(["pcb_place"]);
  try {
    const result = await client.callTool({
      name: "pcb_place",
      arguments: {
        placements: [{ reference: "D1", x: 27, y: 23, flip: true }],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("use position: {x, y} in mm");
  } finally {
    await client.close();
    await server.close();
  }
});

test("direct MCP rejects unknown top-level mutation fields", async () => {
  const { client, server } = await pair(["pcb_place"]);
  try {
    const result = await client.callTool({ name: "pcb_place", arguments: {
      placements: [{ reference: "D1", position: { x: 27, y: 23 } }], typo: true,
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("typo");
  } finally { await client.close(); await server.close(); }
});
