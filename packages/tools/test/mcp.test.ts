import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { attachToRegistry, createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function pair() {
  const registry = createRegistry();
  const project = await tempProject("mcp");
  const services = mockServices([project]);
  const server = new McpServer({ name: "fabdesk-test", version: "0.0.0" });
  const attachment = attachToRegistry(server, registry, contextFactory(services, project));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return { client, server, attachment, project, services, registry };
}

describe("mcp adapter", () => {
  test("core tools visible, load_toolset enables more and emits list_changed", async () => {
    const { client, attachment } = await pair();
    const initial = await client.listTools();
    const names = initial.tools.map((t) => t.name).sort();
    expect(names).toEqual(["circuit_build", "circuit_read_errors", "load_toolset", "pcb_environment", "project_status", "render_board", "route_run", "verify_drc"]);
    const t = initial.tools.find((x) => x.name === "circuit_build")!;
    expect((t.inputSchema as { properties: Record<string, unknown> }).properties["project"]).toBeDefined();
    expect(t.annotations?.idempotentHint).toBe(true);

    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    const res = await client.callTool({ name: "load_toolset", arguments: { toolset: "export" } });
    expect(res.isError).toBeFalsy();
    const after = await client.listTools();
    expect(after.tools.map((t) => t.name)).toContain("export_gerbers");
    expect(after.tools.length).toBe(8 + 7);
    expect(attachment.session.enabledToolsets()).toEqual(["core", "export"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(listChanged).toBeGreaterThan(0);
  });

  test("project_status, build with progress, structured content and errors", async () => {
    const { client } = await pair();
    const status = await client.callTool({ name: "project_status", arguments: {} });
    const text = (status.content as Array<{ type: string; text?: string }>)[0]!.text!;
    expect(text).toContain('Project "mcp"');
    expect((status.structuredContent as { name: string }).name).toBe("mcp");

    const progress: number[] = [];
    const build = await client.callTool({ name: "circuit_build", arguments: {} }, undefined, { onprogress: (p) => progress.push(p.progress) });
    expect(build.isError).toBeFalsy();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(100);

    const bad = await client.callTool({ name: "circuit_read_errors", arguments: { project: "does-not-exist" } });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]!.text).toContain("no project selected");
  });

  test("svg render returns an embedded resource; resources are listed without workflow prompts", async () => {
    const { client, project } = await pair();
    await client.callTool({ name: "circuit_build", arguments: {} });
    await client.callTool({ name: "load_toolset", arguments: { toolset: "render" } });
    const svg = await client.callTool({ name: "render_pcb_svg", arguments: {} });
    const blocks = svg.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "resource"]);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "fabdesk://project/{id}/board-summary",
      "fabdesk://project/{id}/circuit.netlist.json",
      "fabdesk://project/{id}/manifest",
      "fabdesk://project/{id}/reports/{name}",
    ]);
    const list = await client.listResources();
    expect(list.resources.some((r) => r.uri === `fabdesk://project/${project.id}/manifest`)).toBe(true);
    const manifest = await client.readResource({ uri: `fabdesk://project/${project.id}/manifest` });
    expect(JSON.parse(manifest.contents[0]!.text as string).name).toBe("mcp");
    const summary = await client.readResource({ uri: `fabdesk://project/${project.id}/board-summary` });
    expect(JSON.parse(summary.contents[0]!.text as string).built).toBe(true);
    const report = await client.readResource({ uri: `fabdesk://project/${project.id}/reports/build` });
    expect(JSON.parse(report.contents[0]!.text as string).ok).toBe(true);

    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });
});
